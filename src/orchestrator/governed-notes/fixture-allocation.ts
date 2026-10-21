import type { FreshGovernedNoteFixtureV1, GovernedNoteRunV1 } from "./contracts.js";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { allocateForGovernedNoteRun, type GovernedNoteFreshInitializationPortV1 } from "./run.js";
import { GovernedNoteError } from "./errors.js";
import { snapshotFreshStartContext } from "../fresh-start/fresh-start-admission.js";
import { decodeWorkerBinding, encodeWorkerBinding } from "../runtime/worker-protocol.js";
import { ProjectDescriptorRepository } from "../identity/project-descriptor.repository.js";
import { StoreManifestRepository } from "../identity/store-manifest.repository.js";
import { ProjectStoreRouter } from "../identity/project-store.router.js";
import { GitWorkspaceResolver, SpawnSyncGitCommandRunner } from "../identity/git-workspace.resolver.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { retainedExactRecord } from "../privacy/evidence-contracts.js";

export function allocateFreshGovernedNoteFixtureV1(run: GovernedNoteRunV1, input: Readonly<{parentDirectory: string}>): Promise<FreshGovernedNoteFixtureV1> { return allocateForGovernedNoteRun(run, input); }

type PhysicalIdentity = Readonly<{path: string; directory: boolean; device: bigint; inode: bigint; birthtime: bigint}>;
type Initialized = Awaited<ReturnType<GovernedNoteFreshInitializationPortV1["initialize"]>>;
export type AllocatedGovernedNoteFixture = Initialized & Readonly<{fixtureId: string; freshDirectory: string; identities: readonly PhysicalIdentity[]}>;
function unavailable(): never { throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE"); }
function capture(path: string, directory: boolean): PhysicalIdentity {
  if (!isAbsolute(path) || resolve(path) !== path) unavailable();
  // Capture before native lookup, then recheck: lookup must not silently make
  // a newly substituted inode the original allocation's identity baseline.
  const stat = lstatSync(path, {bigint:true});
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) unavailable();
  if (realpathSync.native(path) !== path) unavailable();
  const after = lstatSync(path, {bigint:true});
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.birthtimeNs !== stat.birthtimeNs
    || after.isSymbolicLink() || (directory ? !after.isDirectory() : !after.isFile() || after.nlink !== 1n)) unavailable();
  return Object.freeze({path,directory,device:stat.dev,inode:stat.ino,birthtime:stat.birthtimeNs});
}
function ancestry(path: string): PhysicalIdentity[] {
  const result:PhysicalIdentity[]=[];
  for(let current=path;;current=dirname(current)) {result.push(capture(current,true));if(dirname(current)===current)break;}
  return result;
}
function recheck(identities: readonly PhysicalIdentity[]): void {
  for(const expected of identities) {const now=capture(expected.path,expected.directory);if(now.device!==expected.device||now.inode!==expected.inode||now.birthtime!==expected.birthtime)unavailable();}
}
function contains(root: string, path: string): void {
  const part=relative(root,path);if(!isAbsolute(path)||resolve(path)!==path||part===".."||part.startsWith(`..${process.platform==="win32"?"\\":"/"}`)||isAbsolute(part))unavailable();
}
function freezeContext(initialized: Initialized): Initialized {
  const context=decodeWorkerBinding(encodeWorkerBinding(initialized.context));
  Object.freeze(context.binding.storeRoute);Object.freeze(context.binding.workspace);Object.freeze(context.binding);Object.freeze(context.workspace);Object.freeze(context);
  return Object.freeze({context,freshStartContext:snapshotFreshStartContext(initialized.freshStartContext)});
}
function inspectInitialized(freshDirectory:string, initialized:Initialized): PhysicalIdentity[] {
  const b=initialized.context.binding;
  for(const path of [b.projectRoot,b.vaultRoot,b.descriptorPath,b.storeRoute.storeRoot,b.storeRoute.eventsPath,b.storeRoute.storeManifestPath,b.storeRoute.projectionManifestPath])contains(freshDirectory,path);
  const descriptor=new ProjectDescriptorRepository().inspect(b.vaultRoot);
  if(descriptor.status!=="valid"||descriptor.path!==b.descriptorPath||descriptor.descriptor.projectId!==b.projectId||descriptor.descriptor.vaultId!==b.vaultId)unavailable();
  const workspace=new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()).inspect(b.projectRoot,descriptor.descriptor);
  if(canonicalJson(workspace)!==canonicalJson(b.workspace)||canonicalJson(workspace)!==canonicalJson(initialized.context.workspace))unavailable();
  const route=new ProjectStoreRouter().route(descriptor.descriptor,b.vaultRoot,workspace);
  if(canonicalJson(route)!==canonicalJson(b.storeRoute))unavailable();
  const manifest=new StoreManifestRepository().inspect(route,b);
  if(manifest.status!=="valid")unavailable();
  for(const key of ["projectId","vaultId","storeId"] as const)if(initialized.freshStartContext.identity[key]!==b[key])unavailable();
  const identities=[...ancestry(b.projectRoot),...ancestry(b.vaultRoot),...ancestry(route.storeRoot),capture(b.descriptorPath,false),capture(route.storeManifestPath,false),capture(route.eventsPath,false),...ancestry(join(route.storeRoot,"fresh-start-projection")),...(existsSync(route.projectionManifestPath)?[capture(route.projectionManifestPath,false)]:[])];
  // The current-projection pointer is not a required initializer output. Its
  // containing directory and exact route are verified without inventing a file.
  return identities;
}

/** Per-run membership; constructing another allocator cannot mint for this one.
 * These are path observations, not held SQLite-fd custody or an ABA guarantee.
 * No existing-store input, retry, reset, deletion or resource-release inference.
 */
export class FreshGovernedNoteAllocation {
  readonly #fixtures=new WeakMap<FreshGovernedNoteFixtureV1,AllocatedGovernedNoteFixture>();
  constructor(private readonly initializer:GovernedNoteFreshInitializationPortV1) {}
  async allocate(input:Readonly<{parentDirectory:string}>):Promise<FreshGovernedNoteFixtureV1> {
    try {
      const record=retainedExactRecord(input,["parentDirectory"]);
      if(typeof record.parentDirectory!=="string")unavailable();
      const parent=record.parentDirectory,parents=ancestry(parent),fixtureId=randomUUID(),freshDirectory=join(parent,fixtureId);
      contains(parent,freshDirectory);if(freshDirectory===parent)unavailable();
      mkdirSync(freshDirectory); // Exclusive and nonrecursive: collision always refuses.
      const original=[...parents,capture(freshDirectory,true)];recheck(original);
      const initialized=freezeContext(await this.initializer.initialize(Object.freeze({freshDirectory,fixtureId})));
      recheck(original);
      const identities=Object.freeze([...original,...inspectInitialized(freshDirectory,initialized)]);recheck(identities);
      const fixture=Object.freeze({}) as FreshGovernedNoteFixtureV1;
      this.#fixtures.set(fixture,Object.freeze({...initialized,fixtureId,freshDirectory,identities}));return fixture;
    } catch {return unavailable();}
  }
  lookup(fixture:FreshGovernedNoteFixtureV1):AllocatedGovernedNoteFixture {
    const record=this.#fixtures.get(fixture);if(!record)throw new GovernedNoteError("GOVERNED_NOTE_INPUT_INVALID");return record;
  }
  verify(record:AllocatedGovernedNoteFixture):void {
    try {recheck(record.identities);inspectInitialized(record.freshDirectory,record);recheck(record.identities);}catch{return unavailable();}
  }
}
