export function renderVendorRuntimeJs(): string {
  return `// ============================================================================
// Project Memory V2 WebUI — Self-Contained React + TanStack Query + TanStack Table Runtime
// Endpoint: /mvc/vendor.js
// Exports: window.React, window.ReactDOM, window.TanStackQuery, window.TanStackTable
// ============================================================================
(function (global) {
  const SVG_TAGS = new Set(["svg", "g", "line", "circle", "text", "path", "rect", "defs", "marker", "linearGradient", "stop", "polyline", "polygon", "title"]);
  const PANEL_CUSTOM_TAGS = new Set([
    "pm-mission-control",
    "pm-overview-panel",
    "pm-kanban-board",
    "pm-knowledge-graph",
    "pm-curator-studio",
    "pm-mcp-console",
    "pm-session-activity-map",
  ]);
  const Fragment = Symbol("React.Fragment");

  const sharedComponentHooks = new Map();
  const activeRoots = new Set();
  const contextTrackerStack = [];
  const hookKeyTrackerStack = [];
  let mountCounter = 0;
  let currentRoot = null;
  let currentComponentKey = "root";
  let hookCursor = 0;

  function createElement(type, props, ...children) {
    const flatChildren = [];
    const pushChild = (c) => {
      if (Array.isArray(c)) {
        c.forEach(pushChild);
      } else if (c === null || c === undefined || c === false || c === true) {
        flatChildren.push(null);
      } else {
        flatChildren.push(typeof c === "object" ? c : String(c));
      }
    };
    children.forEach(pushChild);
    return {
      type,
      props: { ...(props || {}), children: flatChildren },
    };
  }

  function createContext(defaultValue) {
    const ctx = {
      _currentValue: defaultValue,
      Provider: function ContextProvider(props) {
        return { type: Fragment, props: { children: props.children || [] } };
      },
    };
    ctx.Provider._contextRef = ctx;
    return ctx;
  }

  function useContext(ctx) {
    const val = ctx._currentValue;
    for (let i = 0; i < contextTrackerStack.length; i++) {
      if (!contextTrackerStack[i].has(ctx)) {
        contextTrackerStack[i].set(ctx, val);
      }
    }
    return val;
  }

  function getHookSlot() {
    if (!currentRoot) throw new Error("React Hook called outside render");
    const rootId = currentRoot.mountId || currentRoot.rootTag || "ROOT";
    const projScope =
      currentRoot.container && currentRoot.container.getAttribute
        ? currentRoot.container.getAttribute("project-root") ||
          currentRoot.container.getAttribute("default-project") ||
          ""
        : "";
    const key = rootId + "::" + projScope + "::" + (currentComponentKey || "root");
    let hooks = sharedComponentHooks.get(key);
    if (!hooks) {
      hooks = [];
      sharedComponentHooks.set(key, hooks);
    }
    currentRoot.ownedHookKeys.add(key);
    if (currentRoot.visitedHookKeys) {
      currentRoot.visitedHookKeys.add(key);
    }
    for (let i = 0; i < hookKeyTrackerStack.length; i++) {
      hookKeyTrackerStack[i].add(key);
    }
    const idx = hookCursor++;
    return { hooks, idx };
  }

  function useState(initialValue) {
    const { hooks, idx } = getHookSlot();
    const rootRef = currentRoot;
    const ownerCompKey = currentComponentKey || "root";
    if (!(idx in hooks)) {
      hooks[idx] = typeof initialValue === "function" ? initialValue() : initialValue;
    }
    const setState = (updater) => {
      if (rootRef.unmounted) {
        return;
      }
      const prev = hooks[idx];
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (!Object.is(prev, next)) {
        hooks[idx] = next;
        if (rootRef.dirtyComponents) {
          rootRef.dirtyComponents.add(ownerCompKey);
        }
        rootRef.scheduleRender();
      }
    };
    return [hooks[idx], setState];
  }

  function depsChanged(prevDeps, nextDeps) {
    if (!prevDeps || !nextDeps || prevDeps.length !== nextDeps.length) return true;
    for (let i = 0; i < nextDeps.length; i++) {
      if (!Object.is(prevDeps[i], nextDeps[i])) return true;
    }
    return false;
  }

  function useRef(initialValue) {
    const { hooks, idx } = getHookSlot();
    if (!(idx in hooks)) {
      hooks[idx] = { current: initialValue };
    }
    return hooks[idx];
  }

  function useMemo(factory, deps) {
    const { hooks, idx } = getHookSlot();
    const prev = hooks[idx];
    if (!prev || depsChanged(prev.deps, deps)) {
      const value = factory();
      hooks[idx] = { value, deps };
      return value;
    }
    return prev.value;
  }

  function useCallback(fn, deps) {
    return useMemo(() => fn, deps);
  }

  function useEffect(effect, deps) {
    const { hooks, idx } = getHookSlot();
    const rootRef = currentRoot;
    const prev = hooks[idx];
    if (!prev || depsChanged(prev.deps, deps)) {
      hooks[idx] = { deps, cleanup: prev ? prev.cleanup : null };
      rootRef.pendingEffects.push(() => {
        if (hooks[idx] && typeof hooks[idx].cleanup === "function") {
          try {
            hooks[idx].cleanup();
          } catch (_e) {}
        }
        const cleanup = effect();
        if (hooks[idx]) {
          hooks[idx].cleanup = typeof cleanup === "function" ? cleanup : null;
        }
      });
    }
  }

  function shallowEqualProps(a, b) {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      const k = keysA[i];
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (k === "children") {
        const ca = a.children;
        const cb = b.children;
        if (Array.isArray(ca) && Array.isArray(cb)) {
          if (ca.length !== cb.length) return false;
          for (let j = 0; j < ca.length; j++) {
            if (!Object.is(ca[j], cb[j])) return false;
          }
          continue;
        }
      }
      if (!Object.is(a[k], b[k])) return false;
    }
    return true;
  }

  function isSubtreeDirty(dirtySet, compKey) {
    if (!dirtySet || dirtySet.has("*")) return true;
    for (const dk of dirtySet) {
      if (dk === compKey || dk.startsWith(compKey + ".") || dk.startsWith(compKey + ":")) {
        return true;
      }
    }
    return false;
  }

  function contextsUnchanged(contextMap) {
    if (!contextMap || contextMap.size === 0) return true;
    for (const [ctxObj, prevVal] of contextMap.entries()) {
      if (!Object.is(ctxObj._currentValue, prevVal)) return false;
    }
    return true;
  }

  // ==========================================================================
  // In-Place VDOM Evaluation & Reconciliation (Preserves DOM Identity & Thai IME)
  // ==========================================================================
  function evaluateToDescriptors(vnode, isSvg, path, out) {
    if (vnode === null || vnode === undefined || typeof vnode === "boolean") {
      return;
    }
    if (typeof vnode === "string" || typeof vnode === "number") {
      out.push({ kind: "text", text: String(vnode), slot: path });
      return;
    }
    if (Array.isArray(vnode)) {
      for (let i = 0; i < vnode.length; i++) {
        evaluateToDescriptors(vnode[i], isSvg, path + "." + i, out);
      }
      return;
    }
    if (vnode.type === Fragment) {
      const ch = (vnode.props && vnode.props.children) || [];
      for (let i = 0; i < ch.length; i++) {
        evaluateToDescriptors(ch[i], isSvg, path + ".f" + i, out);
      }
      return;
    }
    if (typeof vnode.type === "function" && vnode.type._contextRef) {
      const ctx = vnode.type._contextRef;
      const prevVal = ctx._currentValue;
      const nextProps = vnode.props || {};
      ctx._currentValue = nextProps.value;
      try {
        const ch = nextProps.children || [];
        for (let i = 0; i < ch.length; i++) {
          evaluateToDescriptors(ch[i], isSvg, path + ".p" + i, out);
        }
      } finally {
        ctx._currentValue = prevVal;
      }
      return;
    }
    if (typeof vnode.type === "function") {
      const compName = vnode.type.displayName || vnode.type.name || "Component";
      const explicitKey = vnode.props && vnode.props.key != null ? String(vnode.props.key) : "";
      const compKey = path + ":" + compName + (explicitKey ? "#" + explicitKey : "");
      const nextProps = vnode.props || {};
      const cache = currentRoot && currentRoot.compCache;
      const dirtySnap = currentRoot && currentRoot.activeDirtySnapshot;
      if (cache) {
        const cached = cache.get(compKey);
        if (
          cached &&
          cached.type === vnode.type &&
          !isSubtreeDirty(dirtySnap, compKey) &&
          shallowEqualProps(cached.props, nextProps) &&
          contextsUnchanged(cached.contexts)
        ) {
          for (let i = 0; i < cached.descriptors.length; i++) {
            out.push(cached.descriptors[i]);
          }
          if (cached.hookKeys) {
            for (const hk of cached.hookKeys) {
              if (currentRoot && currentRoot.visitedHookKeys) {
                currentRoot.visitedHookKeys.add(hk);
              }
              for (let m = 0; m < hookKeyTrackerStack.length; m++) {
                hookKeyTrackerStack[m].add(hk);
              }
            }
          }
          for (let k = 0; k < contextTrackerStack.length; k++) {
            for (const [ctxObj, val] of cached.contexts.entries()) {
              if (!contextTrackerStack[k].has(ctxObj)) {
                contextTrackerStack[k].set(ctxObj, val);
              }
            }
          }
          return;
        }
      }

      const prevCompKey = currentComponentKey;
      const prevCursor = hookCursor;
      const ctxFrame = new Map();
      const hkFrame = new Set();
      contextTrackerStack.push(ctxFrame);
      hookKeyTrackerStack.push(hkFrame);
      currentComponentKey = compKey;
      hookCursor = 0;
      const compDescriptors = [];
      let subTree;
      try {
        subTree = vnode.type(nextProps);
        evaluateToDescriptors(subTree, isSvg, compKey, compDescriptors);
      } finally {
        hookKeyTrackerStack.pop();
        contextTrackerStack.pop();
        currentComponentKey = prevCompKey;
        hookCursor = prevCursor;
      }
      if (cache) {
        cache.set(compKey, {
          type: vnode.type,
          props: nextProps,
          contexts: ctxFrame,
          hookKeys: hkFrame,
          descriptors: compDescriptors,
        });
      }
      for (let i = 0; i < compDescriptors.length; i++) {
        out.push(compDescriptors[i]);
      }
      return;
    }

    const tag = String(vnode.type);
    const svgMode = isSvg || SVG_TAGS.has(tag);
    const isCustomEl = !svgMode && tag.includes("-");
    const props = vnode.props || {};
    const explicitKey = props.key != null ? String(props.key) : "";
    const childSpecs = [];
    const rawChildren = props.children || [];
    const hasRealChildren = rawChildren.some((c) => c !== null && c !== undefined && c !== false && c !== true);
    if (!isCustomEl || hasRealChildren) {
      for (let i = 0; i < rawChildren.length; i++) {
        evaluateToDescriptors(rawChildren[i], svgMode, path + "." + i, childSpecs);
      }
    }
    out.push({
      kind: "element",
      tag,
      tagLower: tag.toLowerCase(),
      svgMode,
      isCustomEl,
      key: explicitKey,
      slot: explicitKey ? "#" + explicitKey : path,
      props,
      children: childSpecs,
    });
  }

  function collectOwnedCustomElements(node, outMap) {
    if (!node || !node.childNodes) return;
    const walk = (parent) => {
      const children = parent.childNodes;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!child || child.nodeType !== 1 || !child.tagName) continue;
        const tagLower = String(child.tagName).toLowerCase();
        if (tagLower.includes("-")) {
          let list = outMap.get(tagLower);
          if (!list) {
            list = [];
            outMap.set(tagLower, list);
          }
          if (!list.includes(child)) {
            list.push(child);
          }
        } else {
          walk(child);
        }
      }
    };
    if (node.nodeType === 1 && node.tagName && String(node.tagName).includes("-")) {
      const tl = String(node.tagName).toLowerCase();
      let list = outMap.get(tl);
      if (!list) {
        list = [];
        outMap.set(tl, list);
      }
      if (!list.includes(node)) {
        list.push(node);
      }
      return;
    }
    walk(node);
  }

  function wireDomEvent(el, domEvent, fn, isTextControl) {
    if (!el._pmHandlers) el._pmHandlers = {};
    if (!el._pmBoundEvents) el._pmBoundEvents = new Set();
    if (isTextControl && !el._pmImeWired) {
      el._pmImeWired = true;
      el._isComposing = false;
      el.addEventListener("compositionstart", () => {
        el._isComposing = true;
      });
      el.addEventListener("compositionend", (ev) => {
        if (el._isComposing) {
          el._isComposing = false;
          const activeInputFn = el._pmHandlers && el._pmHandlers["input"];
          if (typeof activeInputFn === "function") {
            activeInputFn(ev);
          }
        }
      });
    }
    el._pmHandlers[domEvent] = fn;
    if (!el._pmBoundEvents.has(domEvent)) {
      el._pmBoundEvents.add(domEvent);
      el.addEventListener(domEvent, (ev) => {
        if (domEvent === "input" && el._isComposing) {
          return;
        }
        if (
          domEvent === "keydown" &&
          (el._isComposing || (ev && (ev.isComposing === true || ev.keyCode === 229)))
        ) {
          return;
        }
        const handler = el._pmHandlers && el._pmHandlers[domEvent];
        if (typeof handler === "function") {
          handler(ev);
        }
      });
    }
  }

  function applyElementProps(el, spec, isNew) {
    const { tagLower, svgMode, isCustomEl, props } = spec;
    const prevProps = el._pmProps || {};
    const isTextControl = tagLower === "input" || tagLower === "textarea";
    let customElAttrChanged = false;

    // 1. Clean up removed props/handlers/styles from previous render
    for (const oldKey of Object.keys(prevProps)) {
      if (oldKey === "children" || oldKey === "key" || oldKey === "ref") continue;
      const nextVal = props[oldKey];
      const wasRemoved = nextVal === undefined || nextVal === null || nextVal === false;
      if (oldKey.startsWith("on") && typeof prevProps[oldKey] === "function") {
        if (typeof nextVal !== "function") {
          const evt = oldKey.slice(2).toLowerCase();
          const domEvent = evt === "change" && isTextControl ? "input" : evt;
          if (el._pmHandlers) el._pmHandlers[domEvent] = null;
        }
        continue;
      }
      if (!wasRemoved) continue;
      if (oldKey === "className" || oldKey === "class") {
        if (svgMode) el.removeAttribute("class");
        else el.className = "";
      } else if (oldKey === "style" && prevProps.style && typeof prevProps.style === "object") {
        for (const sKey of Object.keys(prevProps.style)) {
          el.style[sKey] = "";
        }
      } else if (oldKey === "disabled") {
        el.disabled = false;
        el.removeAttribute("disabled");
      } else if (oldKey === "checked" && tagLower === "input") {
        el.checked = false;
      } else if (oldKey === "value") {
        if (!el._isComposing) el.value = "";
      } else if (oldKey !== "data-pm-mount-id") {
        el.removeAttribute(oldKey);
        customElAttrChanged = true;
      }
    }

    if (
      prevProps.style &&
      typeof prevProps.style === "object" &&
      props.style &&
      typeof props.style === "object"
    ) {
      for (const sKey of Object.keys(prevProps.style)) {
        if (!(sKey in props.style)) {
          el.style[sKey] = "";
        }
      }
    }

    // 2. Apply current props
    const nextAttrNames = isCustomEl ? new Set(["data-pm-mount-id"]) : null;
    for (const [key, val] of Object.entries(props)) {
      if (key === "children" || key === "key" || val === undefined || val === null || val === false) {
        continue;
      }
      if (key === "ref") {
        if (typeof val === "object") val.current = el;
        else if (typeof val === "function") val(el);
        continue;
      }
      if (key === "className" || key === "class") {
        if (nextAttrNames) nextAttrNames.add("class");
        const nextCls = String(val);
        if (svgMode) {
          if (el.getAttribute("class") !== nextCls) el.setAttribute("class", nextCls);
        } else if (el.className !== nextCls) {
          el.className = nextCls;
        }
        continue;
      }
      if (key === "style" && typeof val === "object") {
        if (nextAttrNames) nextAttrNames.add("style");
        for (const [sKey, sVal] of Object.entries(val)) {
          const nextStyleVal = sVal == null ? "" : String(sVal);
          if (el.style[sKey] !== nextStyleVal) {
            el.style[sKey] = nextStyleVal;
          }
        }
        continue;
      }
      if (key.startsWith("on") && typeof val === "function") {
        const evt = key.slice(2).toLowerCase();
        const domEvent = evt === "change" && isTextControl ? "input" : evt;
        wireDomEvent(el, domEvent, val, isTextControl);
        continue;
      }
      if (key === "value" && (isTextControl || tagLower === "select")) {
        const nextVal = String(val);
        if (!el._isComposing && el.value !== nextVal) {
          el.value = nextVal;
        }
        if (isNew && tagLower !== "select") {
          el.setAttribute("value", nextVal);
        }
        continue;
      }
      if (key === "checked" && tagLower === "input") {
        const nextChecked = Boolean(val);
        if (el.checked !== nextChecked) el.checked = nextChecked;
        continue;
      }
      if (key === "disabled") {
        if (val) {
          if (nextAttrNames) nextAttrNames.add("disabled");
          el.disabled = true;
          if (el.getAttribute("disabled") !== "disabled") {
            el.setAttribute("disabled", "disabled");
          }
        }
        continue;
      }
      if (nextAttrNames) nextAttrNames.add(key);
      const nextStr = String(val);
      if (el.getAttribute(key) !== nextStr) {
        el.setAttribute(key, nextStr);
        customElAttrChanged = true;
      }
    }

    if (!isNew && isCustomEl && nextAttrNames && el.getAttributeNames) {
      for (const attrName of el.getAttributeNames()) {
        if (!nextAttrNames.has(attrName)) {
          el.removeAttribute(attrName);
          customElAttrChanged = true;
        }
      }
      if (
        (customElAttrChanged || PANEL_CUSTOM_TAGS.has(tagLower)) &&
        el._root &&
        typeof el._root.scheduleRender === "function"
      ) {
        el._root.scheduleRender();
      }
    }

    el._pmProps = props;
    el._pmKey = spec.key || "";
    el._pmSlot = spec.slot || "";
  }

  function createDomFromSpec(spec) {
    if (spec.kind === "text") {
      const tn = document.createTextNode(spec.text);
      tn._pmSlot = spec.slot || "";
      return tn;
    }
    let reusedCustomEl = null;
    if (spec.isCustomEl && currentRoot && currentRoot.reusableCustomElements) {
      const bucket = currentRoot.reusableCustomElements.get(spec.tagLower);
      if (bucket && bucket.length > 0) {
        reusedCustomEl = bucket.shift();
      }
    }
    const isNew = !reusedCustomEl;
    const el =
      reusedCustomEl ||
      (spec.svgMode
        ? document.createElementNS("http://www.w3.org/2000/svg", spec.tag)
        : document.createElement(spec.tag));

    applyElementProps(el, spec, isNew);

    if (!spec.isCustomEl || spec.children.length > 0) {
      if (isNew && (!el.childNodes || el.childNodes.length === 0)) {
        for (let i = 0; i < spec.children.length; i++) {
          el.appendChild(createDomFromSpec(spec.children[i]));
        }
      } else {
        patchChildren(el, spec.children);
      }
    }

    if (spec.tagLower === "select" && spec.props.value != null) {
      const selVal = String(spec.props.value);
      if (el.value !== selVal) el.value = selVal;
    }
    return el;
  }

  function canPatchInPlace(domNode, spec) {
    if (!domNode || !spec) return false;
    if (spec.kind === "text") {
      if (domNode.nodeType !== 3) return false;
      if (domNode._pmSlot && spec.slot && domNode._pmSlot !== spec.slot) return false;
      return true;
    }
    if (domNode.nodeType !== 1 || !domNode.tagName) return false;
    if (String(domNode.tagName).toLowerCase() !== spec.tagLower) return false;
    const domKey = domNode._pmKey || "";
    const specKey = spec.key || "";
    if (domKey || specKey) {
      return domKey === specKey;
    }
    if (domNode._pmSlot && spec.slot) {
      return domNode._pmSlot === spec.slot;
    }
    return true;
  }

  function patchExistingDomNode(domNode, spec) {
    if (spec.kind === "text") {
      if (domNode.textContent !== spec.text) {
        domNode.textContent = spec.text;
      }
      domNode._pmSlot = spec.slot || "";
      return domNode;
    }
    applyElementProps(domNode, spec, false);
    if (!spec.isCustomEl || spec.children.length > 0) {
      patchChildren(domNode, spec.children);
    }
    if (spec.tagLower === "select" && spec.props.value != null) {
      const selVal = String(spec.props.value);
      if (domNode.value !== selVal) domNode.value = selVal;
    }
    return domNode;
  }

  function patchChildren(parentDom, nextSpecs) {
    const liveList = parentDom.childNodes ? Array.from(parentDom.childNodes) : [];
    const commonLen = Math.min(liveList.length, nextSpecs.length);
    let idx = 0;
    while (idx < commonLen && canPatchInPlace(liveList[idx], nextSpecs[idx])) {
      patchExistingDomNode(liveList[idx], nextSpecs[idx]);
      idx += 1;
    }

    if (idx === liveList.length && idx === nextSpecs.length) {
      return;
    }

    let oldEnd = liveList.length - 1;
    let newEnd = nextSpecs.length - 1;
    const canInsertBefore = typeof parentDom.insertBefore === "function";
    if (canInsertBefore) {
      while (oldEnd >= idx && newEnd >= idx && canPatchInPlace(liveList[oldEnd], nextSpecs[newEnd])) {
        patchExistingDomNode(liveList[oldEnd], nextSpecs[newEnd]);
        oldEnd -= 1;
        newEnd -= 1;
      }
    }

    if (oldEnd < idx && newEnd < idx) {
      return;
    }

    const suffixAnchor = canInsertBefore && oldEnd + 1 < liveList.length ? liveList[oldEnd + 1] : null;
    const insertBeforeAnchor = (node) => {
      if (suffixAnchor) {
        parentDom.insertBefore(node, suffixAnchor);
      } else {
        parentDom.appendChild(node);
      }
    };

    const rescueMap = currentRoot && currentRoot.reusableCustomElements;

    if (oldEnd < idx) {
      for (let j = idx; j <= newEnd; j++) {
        insertBeforeAnchor(createDomFromSpec(nextSpecs[j]));
      }
      return;
    }

    if (newEnd < idx) {
      for (let j = oldEnd; j >= idx; j--) {
        if (rescueMap) collectOwnedCustomElements(liveList[j], rescueMap);
        parentDom.removeChild(liveList[j]);
      }
      return;
    }

    // Reconcile divergent middle slice while reusing keyed elements and Custom Elements
    const keyedPool = new Map();
    for (let j = idx; j <= oldEnd; j++) {
      const rem = liveList[j];
      if (rem && rem.nodeType === 1 && rem._pmKey && rem.tagName) {
        keyedPool.set(String(rem.tagName).toLowerCase() + "::" + rem._pmKey, rem);
      } else if (rescueMap) {
        collectOwnedCustomElements(rem, rescueMap);
      }
      parentDom.removeChild(rem);
    }

    for (let j = idx; j <= newEnd; j++) {
      const spec = nextSpecs[j];
      if (spec.kind === "element" && spec.key) {
        const poolKey = spec.tagLower + "::" + spec.key;
        const matched = keyedPool.get(poolKey);
        if (matched) {
          keyedPool.delete(poolKey);
          patchExistingDomNode(matched, spec);
          insertBeforeAnchor(matched);
          continue;
        }
      }
      insertBeforeAnchor(createDomFromSpec(spec));
    }

    if (rescueMap) {
      for (const leftover of keyedPool.values()) {
        collectOwnedCustomElements(leftover, rescueMap);
      }
    }
  }

  function cleanupHooksByPrefix(rootInst, prefix) {
    for (const key of [...rootInst.ownedHookKeys]) {
      if (!key.startsWith(prefix)) continue;
      const hooks = sharedComponentHooks.get(key);
      if (hooks) {
        hooks.forEach((h) => {
          if (h && typeof h.cleanup === "function") {
            try {
              h.cleanup();
            } catch (_e) {}
            h.cleanup = null;
            h.deps = null;
          }
        });
        sharedComponentHooks.delete(key);
      }
      rootInst.ownedHookKeys.delete(key);
    }
  }

  function createRoot(container) {
    if (container && container.getAttribute && !container.getAttribute("data-pm-mount-id")) {
      mountCounter += 1;
      container.setAttribute("data-pm-mount-id", "pm-m" + mountCounter);
    }
    const assignedMountId =
      (container && container.getAttribute && container.getAttribute("data-pm-mount-id")) ||
      "pm-m" + ++mountCounter;

    const rootInstance = {
      container,
      mountId: assignedMountId,
      rootTag: container && container.tagName ? container.tagName : "ROOT",
      hooks: [],
      ownedHookKeys: new Set(),
      visitedHookKeys: null,
      dirtyComponents: new Set(["*"]),
      activeDirtySnapshot: null,
      compCache: new Map(),
      reusableCustomElements: null,
      lastProjScope: null,
      unmounted: false,
      pendingEffects: [],
      element: null,
      scheduled: false,
      scheduleRender() {
        if (this.scheduled || this.unmounted) return;
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          if (!this.unmounted) {
            this.flushRender();
          }
        });
      },
      flushRender() {
        if (!this.element || this.unmounted) return;
        const rootId = this.mountId || this.rootTag || "ROOT";
        const nextProjScope =
          this.container && this.container.getAttribute
            ? this.container.getAttribute("project-root") ||
              this.container.getAttribute("default-project") ||
              ""
            : "";
        if (this.lastProjScope !== null && this.lastProjScope !== nextProjScope) {
          cleanupHooksByPrefix(this, rootId + "::" + this.lastProjScope + "::");
          this.compCache.clear();
          this.dirtyComponents.add("*");
        }
        this.lastProjScope = nextProjScope;

        const dirtySnap = new Set(this.dirtyComponents);
        this.dirtyComponents.clear();

        // Preserve root container scrollTop/scrollLeft as safety fallback alongside in-place patching
        const rootScrollTop = this.container ? this.container.scrollTop || 0 : 0;
        const rootScrollLeft = this.container ? this.container.scrollLeft || 0 : 0;

        const reusableMap = new Map();
        const visitedSet = new Set();
        const prevRoot = currentRoot;
        const prevCompKey = currentComponentKey;
        const prevCursor = hookCursor;
        currentRoot = this;
        currentComponentKey = "root";
        hookCursor = 0;
        this.pendingEffects = [];
        this.reusableCustomElements = reusableMap;
        this.activeDirtySnapshot = dirtySnap;
        this.visitedHookKeys = visitedSet;

        const nextSpecs = [];
        try {
          evaluateToDescriptors(this.element, false, "0", nextSpecs);
          patchChildren(this.container, nextSpecs);
        } finally {
          this.visitedHookKeys = null;
          this.activeDirtySnapshot = null;
          this.reusableCustomElements = null;
          currentRoot = prevRoot;
          currentComponentKey = prevCompKey;
          hookCursor = prevCursor;
        }

        // Clean up hooks and useEffect subscriptions for child components that unmounted in this render
        const scopePrefix = rootId + "::" + nextProjScope + "::";
        for (const key of [...this.ownedHookKeys]) {
          if (key.startsWith(scopePrefix) && !visitedSet.has(key)) {
            const hooks = sharedComponentHooks.get(key);
            if (hooks) {
              hooks.forEach((h) => {
                if (h && typeof h.cleanup === "function") {
                  try {
                    h.cleanup();
                  } catch (_e) {}
                  h.cleanup = null;
                  h.deps = null;
                }
              });
              sharedComponentHooks.delete(key);
            }
            this.ownedHookKeys.delete(key);
            const compKey = key.slice(scopePrefix.length);
            this.compCache.delete(compKey);
          }
        }

        if (this.container && rootScrollTop && !this.container.scrollTop) {
          this.container.scrollTop = rootScrollTop;
          this.container.scrollLeft = rootScrollLeft;
        }

        const effects = [...this.pendingEffects];
        this.pendingEffects = [];
        effects.forEach((fn) => fn());
      },
      render(element) {
        this.unmounted = false;
        activeRoots.add(this);
        this.element = element;
        this.dirtyComponents.add("*");
        this.flushRender();
      },
      unmount() {
        this.unmounted = true;
        activeRoots.delete(this);
        this.compCache.clear();
        this.dirtyComponents.clear();
        for (const key of this.ownedHookKeys) {
          const hooks = sharedComponentHooks.get(key);
          if (hooks) {
            hooks.forEach((h) => {
              if (h && typeof h.cleanup === "function") {
                try {
                  h.cleanup();
                } catch (_e) {}
                h.cleanup = null;
                h.deps = null;
              }
            });
            sharedComponentHooks.delete(key);
          }
        }
        this.ownedHookKeys.clear();
        this.container.innerHTML = "";
        this.element = null;
      },
    };
    return rootInstance;
  }

  // ==========================================================================
  // TanStack Query (@tanstack/react-query compatible with Key-Scoped PubSub & LRU)
  // ==========================================================================
  const DEFAULT_STALE_TIME_MS = 15000;
  const MAX_QUERY_CACHE_ENTRIES = 100;

  class QueryClient {
    constructor() {
      this.cache = new Map();
      this.keyListeners = new Map();
      this.listeners = new Set();
    }
    hashKey(queryKey) {
      return JSON.stringify(Array.isArray(queryKey) ? queryKey : [queryKey]);
    }
    evictInactiveIfNeeded() {
      if (this.cache.size <= MAX_QUERY_CACHE_ENTRIES) return;
      for (const [k, entry] of this.cache.entries()) {
        if (this.cache.size <= MAX_QUERY_CACHE_ENTRIES) break;
        if ((entry.observerCount || 0) <= 0 && !entry.isFetching) {
          this.cache.delete(k);
        }
      }
    }
    getEntry(queryKey) {
      const k = this.hashKey(queryKey);
      let entry = this.cache.get(k);
      if (entry) {
        this.cache.delete(k);
        this.cache.set(k, entry);
        return entry;
      }
      entry = {
        keyHash: k,
        queryKey,
        data: undefined,
        error: null,
        status: "pending",
        isFetching: false,
        promise: null,
        abortController: null,
        fetchSeq: 0,
        invalidatedAtSeq: 0,
        observerCount: 0,
        updatedAt: 0,
      };
      this.cache.set(k, entry);
      this.evictInactiveIfNeeded();
      return entry;
    }
    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    subscribeKey(keyHash, listener) {
      let set = this.keyListeners.get(keyHash);
      if (!set) {
        set = new Set();
        this.keyListeners.set(keyHash, set);
      }
      set.add(listener);
      const entry = this.cache.get(keyHash);
      if (entry) entry.observerCount = (entry.observerCount || 0) + 1;
      return () => {
        const s = this.keyListeners.get(keyHash);
        if (s) {
          s.delete(listener);
          if (s.size === 0) this.keyListeners.delete(keyHash);
        }
        const cur = this.cache.get(keyHash);
        if (cur && cur.observerCount > 0) {
          cur.observerCount -= 1;
          if (
            cur.observerCount === 0 &&
            cur.isFetching &&
            cur.abortController &&
            typeof cur.abortController.abort === "function"
          ) {
            try {
              cur.abortController.abort();
            } catch (_e) {}
            cur.abortController = null;
            cur.isFetching = false;
            cur.promise = null;
          }
        }
      };
    }
    notify(keyHash) {
      if (keyHash) {
        const scoped = this.keyListeners.get(keyHash);
        if (scoped) scoped.forEach((l) => l());
      } else {
        for (const scoped of this.keyListeners.values()) {
          scoped.forEach((l) => l());
        }
      }
      this.listeners.forEach((l) => l());
    }
    async fetchQuery({ queryKey, queryFn, force = false }) {
      const entry = this.getEntry(queryKey);
      if (entry.isFetching && entry.promise && !force) {
        return entry.promise;
      }
      if (entry.abortController && typeof entry.abortController.abort === "function") {
        try {
          entry.abortController.abort();
        } catch (_e) {}
      }
      const seq = (entry.fetchSeq || 0) + 1;
      entry.fetchSeq = seq;
      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      entry.abortController = ctrl;
      entry.isFetching = true;
      this.notify(entry.keyHash);
      const signal = ctrl ? ctrl.signal : undefined;
      const p = Promise.resolve()
        .then(() => queryFn({ queryKey, signal }))
        .then((data) => {
          if ((ctrl && ctrl.signal && ctrl.signal.aborted) || entry.abortController !== ctrl) {
            return entry.data;
          }
          if ((entry.invalidatedAtSeq || 0) >= seq) {
            entry.abortController = null;
            entry.isFetching = false;
            entry.promise = null;
            entry.updatedAt = 0;
            this.notify(entry.keyHash);
            return data;
          }
          entry.data = data;
          entry.error = null;
          entry.status = "success";
          entry.abortController = null;
          entry.isFetching = false;
          entry.promise = null;
          entry.updatedAt = Date.now();
          this.notify(entry.keyHash);
          return data;
        })
        .catch((err) => {
          if (
            (ctrl && ctrl.signal && ctrl.signal.aborted) ||
            (err && err.name === "AbortError") ||
            entry.abortController !== ctrl
          ) {
            if (entry.abortController === ctrl) {
              entry.abortController = null;
              entry.isFetching = false;
              entry.promise = null;
              this.notify(entry.keyHash);
            }
            return entry.data;
          }
          entry.error = err;
          entry.status = "error";
          entry.abortController = null;
          entry.isFetching = false;
          entry.promise = null;
          entry.updatedAt = Date.now();
          this.notify(entry.keyHash);
          throw err;
        });
      entry.promise = p;
      return p;
    }
    invalidateQueries({ queryKey } = {}) {
      const prefix = queryKey ? (Array.isArray(queryKey) ? queryKey : [queryKey]) : [];
      const matchedHashes = [];
      for (const [k, entry] of this.cache.entries()) {
        const matches =
          prefix.length === 0 ||
          prefix.every((part, idx) => Array.isArray(entry.queryKey) && entry.queryKey[idx] === part);
        if (matches) {
          entry.updatedAt = 0;
          entry.invalidatedAtSeq = entry.fetchSeq || 0;
          if (entry.isFetching) {
            if (entry.abortController && typeof entry.abortController.abort === "function") {
              try {
                entry.abortController.abort();
              } catch (_e) {}
            }
            entry.abortController = null;
            entry.isFetching = false;
            entry.promise = null;
          }
          matchedHashes.push(k);
        }
      }
      for (const k of matchedHashes) {
        this.notify(k);
      }
      if (matchedHashes.length === 0 && prefix.length === 0) {
        this.notify();
      }
    }
  }

  const QueryClientContext = createContext(new QueryClient());

  function QueryClientProvider(props) {
    return createElement(QueryClientContext.Provider, { value: props.client }, ...(props.children || []));
  }

  function useQueryClient() {
    return useContext(QueryClientContext);
  }

  function useQuery({ queryKey, queryFn, enabled = true, staleTime = DEFAULT_STALE_TIME_MS }) {
    const client = useQueryClient();
    const [, setTick] = useState(0);
    const queryFnRef = useRef(queryFn);
    queryFnRef.current = queryFn;
    const keyRef = useRef(queryKey);
    keyRef.current = queryKey;
    const keyHash = client.hashKey(queryKey);
    const entry = client.getEntry(queryKey);

    useEffect(() => {
      return client.subscribeKey(keyHash, () => {
        const current = client.getEntry(keyRef.current);
        if (enabled && current.updatedAt === 0 && !current.isFetching) {
          client.fetchQuery({ queryKey: keyRef.current, queryFn: queryFnRef.current }).catch(() => {});
        }
        setTick((t) => t + 1);
      });
    }, [client, keyHash, enabled]);

    useEffect(() => {
      if (!enabled || entry.isFetching) return;
      const isNeverFetched = entry.updatedAt === 0 || entry.status === "pending";
      const isExpiredSuccess =
        entry.status === "success" && Date.now() - entry.updatedAt > staleTime;
      if (isNeverFetched || isExpiredSuccess) {
        client.fetchQuery({ queryKey: keyRef.current, queryFn: queryFnRef.current }).catch(() => {});
      }
    }, [client, keyHash, enabled, staleTime]);

    return {
      data: entry.data,
      error: entry.error,
      status: entry.status,
      isLoading: entry.status === "pending" && entry.isFetching,
      isFetching: entry.isFetching,
      isError: entry.status === "error",
      isSuccess: entry.status === "success",
      refetch: () => client.fetchQuery({ queryKey, queryFn, force: true }),
    };
  }

  function useMutation({ mutationFn, onSuccess, onError }) {
    const [state, setState] = useState({
      isPending: false,
      isError: false,
      error: null,
      data: undefined,
    });

    const mutateAsync = useCallback(
      async (variables, callOptions = {}) => {
        setState((prev) => ({ ...prev, isPending: true, isError: false, error: null }));
        try {
          const data = await mutationFn(variables);
          setState({ isPending: false, isError: false, error: null, data });
          if (onSuccess) onSuccess(data, variables);
          if (callOptions.onSuccess) callOptions.onSuccess(data, variables);
          return data;
        } catch (error) {
          setState({ isPending: false, isError: true, error, data: undefined });
          if (onError) onError(error, variables);
          if (callOptions.onError) callOptions.onError(error, variables);
          throw error;
        }
      },
      [mutationFn, onSuccess, onError]
    );

    const mutate = useCallback(
      (variables, callOptions) => {
        mutateAsync(variables, callOptions).catch(() => {});
      },
      [mutateAsync]
    );

    return {
      ...state,
      mutate,
      mutateAsync,
    };
  }

  // ==========================================================================
  // TanStack Table (@tanstack/react-table compatible implementation)
  // ==========================================================================
  function createColumnHelper() {
    return {
      accessor: (accessorKey, colDef) => ({
        id: colDef.id || accessorKey,
        accessorKey,
        ...colDef,
      }),
      display: (colDef) => ({
        id: colDef.id,
        ...colDef,
      }),
    };
  }

  function getCoreRowModel() {
    return "core";
  }
  function getFilteredRowModel() {
    return "filtered";
  }
  function getSortedRowModel() {
    return "sorted";
  }

  function flexRender(Comp, props) {
    if (!Comp) return null;
    if (typeof Comp === "function") return Comp(props);
    return Comp;
  }

  function useReactTable({ data = [], columns = [], state = {}, onSortingChange, onGlobalFilterChange }) {
    const sorting = state.sorting || [];
    const globalFilter = String(state.globalFilter || "").trim().toLowerCase();

    const processedRows = useMemo(() => {
      let rows = [...data];
      if (globalFilter) {
        rows = rows.filter((row) =>
          Object.values(row || {}).some((val) =>
            String(Array.isArray(val) ? val.join(" ") : val ?? "")
              .toLowerCase()
              .includes(globalFilter)
          )
        );
      }
      if (sorting.length > 0) {
        const { id, desc } = sorting[0];
        rows.sort((a, b) => {
          const va = String(a[id] ?? "");
          const vb = String(b[id] ?? "");
          const cmp = va.localeCompare(vb, undefined, { numeric: true });
          return desc ? -cmp : cmp;
        });
      }
      return rows.map((original, idx) => ({
        id: String(original.id || original.recordId || original.sessionId || idx),
        original,
        getVisibleCells: () =>
          columns.map((col) => {
            const colId = col.id || col.accessorKey;
            const rawVal = col.accessorFn
              ? col.accessorFn(original)
              : col.accessorKey
                ? original[col.accessorKey]
                : undefined;
            return {
              id: String(idx) + "_" + String(colId),
              column: { columnDef: col },
              getValue: () => rawVal,
              getContext: () => ({
                row: { original },
                getValue: () => rawVal,
              }),
            };
          }),
      }));
    }, [data, columns, sorting, globalFilter]);

    const headerGroups = useMemo(() => {
      return [
        {
          id: "header-group-0",
          headers: columns.map((col) => {
            const colId = col.id || col.accessorKey;
            const currentSort = sorting.find((s) => s.id === colId);
            return {
              id: colId,
              isPlaceholder: false,
              column: {
                id: colId,
                columnDef: col,
                getIsSorted: () => (currentSort ? (currentSort.desc ? "desc" : "asc") : false),
                getToggleSortingHandler: () => () => {
                  if (!onSortingChange) return;
                  if (!currentSort) onSortingChange([{ id: colId, desc: false }]);
                  else if (!currentSort.desc) onSortingChange([{ id: colId, desc: true }]);
                  else onSortingChange([]);
                },
              },
              getContext: () => ({ column: col }),
            };
          }),
        },
      ];
    }, [columns, sorting, onSortingChange]);

    return {
      getHeaderGroups: () => headerGroups,
      getRowModel: () => ({ rows: processedRows }),
      getState: () => ({ sorting, globalFilter }),
      setGlobalFilter: (val) => onGlobalFilterChange && onGlobalFilterChange(val),
    };
  }

  global.React = {
    createElement,
    h: createElement,
    Fragment,
    createContext,
    useContext,
    useState,
    useEffect,
    useMemo,
    useCallback,
    useRef,
  };
  global.ReactDOM = { createRoot };
  global.TanStackQuery = {
    QueryClient,
    QueryClientProvider,
    useQueryClient,
    useQuery,
    useMutation,
  };
  global.TanStackTable = {
    createColumnHelper,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    flexRender,
    useReactTable,
  };
})(window);
`;
}
