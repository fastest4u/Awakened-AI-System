export function renderVendorRuntimeJs(): string {
  return `// ============================================================================
// Project Memory V2 WebUI — Self-Contained React + TanStack Query + TanStack Table Runtime
// Endpoint: /mvc/vendor.js
// Exports: window.React, window.ReactDOM, window.TanStackQuery, window.TanStackTable
// ============================================================================
(function (global) {
  const SVG_TAGS = new Set(["svg", "g", "line", "circle", "text", "path", "rect", "defs", "marker", "linearGradient", "stop", "polyline", "polygon"]);
  const Fragment = Symbol("React.Fragment");

  let currentRoot = null;
  let hookCursor = 0;

  function createElement(type, props, ...children) {
    const flatChildren = [];
    const pushChild = (c) => {
      if (Array.isArray(c)) {
        c.forEach(pushChild);
      } else if (c !== null && c !== undefined && c !== false && c !== true) {
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
        ctx._currentValue = props.value;
        return { type: Fragment, props: { children: props.children || [] } };
      },
    };
    return ctx;
  }

  function useContext(ctx) {
    return ctx._currentValue;
  }

  function getHookSlot() {
    if (!currentRoot) throw new Error("React Hook called outside render");
    const idx = hookCursor++;
    const hooks = currentRoot.hooks;
    return { hooks, idx };
  }

  function useState(initialValue) {
    const { hooks, idx } = getHookSlot();
    const rootRef = currentRoot;
    if (!(idx in hooks)) {
      hooks[idx] = typeof initialValue === "function" ? initialValue() : initialValue;
    }
    const setState = (updater) => {
      const prev = hooks[idx];
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (!Object.is(prev, next)) {
        hooks[idx] = next;
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

  function renderVNodeToDom(vnode, isSvg = false) {
    if (vnode === null || vnode === undefined || typeof vnode === "boolean") {
      return document.createTextNode("");
    }
    if (typeof vnode === "string" || typeof vnode === "number") {
      return document.createTextNode(String(vnode));
    }
    if (Array.isArray(vnode)) {
      const frag = document.createDocumentFragment();
      vnode.forEach((child) => frag.appendChild(renderVNodeToDom(child, isSvg)));
      return frag;
    }
    if (vnode.type === Fragment) {
      const frag = document.createDocumentFragment();
      (vnode.props.children || []).forEach((child) => frag.appendChild(renderVNodeToDom(child, isSvg)));
      return frag;
    }
    if (typeof vnode.type === "function") {
      const subTree = vnode.type(vnode.props || {});
      return renderVNodeToDom(subTree, isSvg);
    }

    const tag = String(vnode.type);
    const svgMode = isSvg || SVG_TAGS.has(tag);
    const el = svgMode
      ? document.createElementNS("http://www.w3.org/2000/svg", tag)
      : document.createElement(tag);

    const props = vnode.props || {};
    for (const [key, val] of Object.entries(props)) {
      if (key === "children" || key === "key" || val === undefined || val === null || val === false) {
        continue;
      }
      if (key === "ref" && typeof val === "object") {
        val.current = el;
        continue;
      }
      if (key === "className" || key === "class") {
        if (svgMode) {
          el.setAttribute("class", String(val));
        } else {
          el.className = String(val);
        }
        continue;
      }
      if (key === "style" && typeof val === "object") {
        Object.assign(el.style, val);
        continue;
      }
      if (key.startsWith("on") && typeof val === "function") {
        const evt = key.slice(2).toLowerCase();
        const domEvent = evt === "change" && (tag === "input" || tag === "textarea") ? "input" : evt;
        el.addEventListener(domEvent, val);
        continue;
      }
      if (key === "value" && (tag === "input" || tag === "textarea" || tag === "select")) {
        el.value = String(val);
        el.setAttribute("value", String(val));
        continue;
      }
      if (key === "checked" && tag === "input") {
        el.checked = Boolean(val);
        continue;
      }
      if (key === "disabled") {
        if (val) el.setAttribute("disabled", "disabled");
        continue;
      }
      el.setAttribute(key, String(val));
    }

    (props.children || []).forEach((child) => {
      el.appendChild(renderVNodeToDom(child, svgMode));
    });

    if (tag === "select" && props.value !== undefined) {
      el.value = String(props.value);
    }

    return el;
  }

  function createRoot(container) {
    const rootInstance = {
      container,
      hooks: [],
      pendingEffects: [],
      element: null,
      scheduled: false,
      scheduleRender() {
        if (this.scheduled) return;
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          this.flushRender();
        });
      },
      flushRender() {
        if (!this.element) return;
        const activeEl = document.activeElement;
        const focusId = activeEl && activeEl.id ? activeEl.id : null;
        const selStart = activeEl && typeof activeEl.selectionStart === "number" ? activeEl.selectionStart : null;
        const selEnd = activeEl && typeof activeEl.selectionEnd === "number" ? activeEl.selectionEnd : null;

        const prevRoot = currentRoot;
        currentRoot = this;
        hookCursor = 0;
        this.pendingEffects = [];

        let domNode;
        try {
          domNode = renderVNodeToDom(this.element, false);
        } finally {
          currentRoot = prevRoot;
        }

        this.container.innerHTML = "";
        this.container.appendChild(domNode);

        if (focusId) {
          const restored = document.getElementById(focusId);
          if (restored && typeof restored.focus === "function") {
            restored.focus();
            if (selStart !== null && typeof restored.setSelectionRange === "function") {
              try {
                restored.setSelectionRange(selStart, selEnd);
              } catch (_e) {}
            }
          }
        }

        const effects = [...this.pendingEffects];
        this.pendingEffects = [];
        effects.forEach((fn) => fn());
      },
      render(element) {
        this.element = element;
        this.flushRender();
      },
      unmount() {
        this.hooks.forEach((h) => {
          if (h && typeof h.cleanup === "function") {
            try {
              h.cleanup();
            } catch (_e) {}
          }
        });
        this.container.innerHTML = "";
        this.element = null;
      },
    };
    return rootInstance;
  }

  // ==========================================================================
  // TanStack Query (@tanstack/react-query compatible implementation)
  // ==========================================================================
  class QueryClient {
    constructor() {
      this.cache = new Map();
      this.listeners = new Set();
    }
    hashKey(queryKey) {
      return JSON.stringify(Array.isArray(queryKey) ? queryKey : [queryKey]);
    }
    getEntry(queryKey) {
      const k = this.hashKey(queryKey);
      if (!this.cache.has(k)) {
        this.cache.set(k, {
          queryKey,
          data: undefined,
          error: null,
          status: "pending",
          isFetching: false,
          promise: null,
          updatedAt: 0,
        });
      }
      return this.cache.get(k);
    }
    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    notify() {
      this.listeners.forEach((l) => l());
    }
    async fetchQuery({ queryKey, queryFn, force = false }) {
      const entry = this.getEntry(queryKey);
      if (entry.isFetching && entry.promise && !force) {
        return entry.promise;
      }
      entry.isFetching = true;
      this.notify();
      const p = Promise.resolve()
        .then(() => queryFn({ queryKey }))
        .then((data) => {
          entry.data = data;
          entry.error = null;
          entry.status = "success";
          entry.isFetching = false;
          entry.updatedAt = Date.now();
          this.notify();
          return data;
        })
        .catch((err) => {
          entry.error = err;
          entry.status = "error";
          entry.isFetching = false;
          this.notify();
          throw err;
        });
      entry.promise = p;
      return p;
    }
    invalidateQueries({ queryKey } = {}) {
      const prefix = queryKey ? (Array.isArray(queryKey) ? queryKey : [queryKey]) : [];
      for (const entry of this.cache.values()) {
        const matches =
          prefix.length === 0 ||
          prefix.every((part, idx) => Array.isArray(entry.queryKey) && entry.queryKey[idx] === part);
        if (matches) {
          entry.updatedAt = 0;
        }
      }
      this.notify();
    }
  }

  const QueryClientContext = createContext(new QueryClient());

  function QueryClientProvider(props) {
    return createElement(QueryClientContext.Provider, { value: props.client }, ...(props.children || []));
  }

  function useQueryClient() {
    return useContext(QueryClientContext);
  }

  function useQuery({ queryKey, queryFn, enabled = true }) {
    const client = useQueryClient();
    const [, setTick] = useState(0);
    const keyHash = client.hashKey(queryKey);
    const entry = client.getEntry(queryKey);

    useEffect(() => {
      return client.subscribe(() => {
        const current = client.getEntry(queryKey);
        if (enabled && current.updatedAt === 0 && !current.isFetching) {
          client.fetchQuery({ queryKey, queryFn }).catch(() => {});
        }
        setTick((t) => t + 1);
      });
    }, [client, keyHash, enabled]);

    useEffect(() => {
      if (enabled && (entry.updatedAt === 0 || entry.status === "pending") && !entry.isFetching) {
        client.fetchQuery({ queryKey, queryFn }).catch(() => {});
      }
    }, [client, keyHash, enabled]);

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
