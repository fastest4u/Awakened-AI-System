import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectNativeRankedQuery } from "../src/orchestrator/verified-read/content-ranking.js";
import { parseProjectionManifestV2, parseProjectionManifestV3 } from "../src/orchestrator/projections/manifest-codec.js";
import { PROJECTION_MANIFEST_FILENAME } from "../src/orchestrator/projections/manifest.js";
import { randomUUID,createHash } from "node:crypto";
import { makeGovernedNoteFixture, makeGovernedNoteFixtureV2 } from "./support/governed-note-fixture.js";
import { createVerifiedReadAdapter } from "../src/orchestrator/verified-read/supervisor.js";

test("exact ID private read returns actual candidate summary at terminal position", {timeout:120000}, async(t)=>{
 let fixture:Awaited<ReturnType<typeof makeGovernedNoteFixture>>|undefined;
 try{
  await assert.doesNotReject(async()=>{fixture=await makeGovernedNoteFixture();});assert.ok(fixture);
  const command={version:1 as const,operation:"create-governed-note" as const,commandId:randomUUID(),idempotencyKey:randomUUID(),recordKind:"insight" as const,summary:"g10unique fixture_secret",confidence:"low" as const,provenance:[{kind:"retained-evidence" as const,identity:fixture.sourceId}]};
  const receipt=await fixture.run.create(fixture.permit,await fixture.prepareCreate(command));
  const binding=await fixture.verifiedReadBinding(receipt);assert.equal(binding.projectionBinding.sessionId,null);assert.equal(binding.session?.sessionId,receipt.scope.sessionId);
  const manifest=parseProjectionManifestV2(JSON.parse(readFileSync(join(binding.projectionDirectory.canonicalPath,PROJECTION_MANIFEST_FILENAME),"utf8")),binding.projectionBinding);
  const image=new DatabaseSync(join(binding.projectionDirectory.canonicalPath,manifest.databaseFile),{readOnly:true});
  try{const ranked=collectNativeRankedQuery(image,manifest,{eligibility:{binding:binding.projectionBinding,sessionId:receipt.scope.sessionId!,visibility:"session"},query:"g10unique",limit:10,requiredEventPosition:receipt.terminalPosition,remainingMs:5000});const actual=ranked.rankedCandidates.find(item=>item.item?.id===receipt.recordId);assert.ok(actual);assert.equal(actual.features.verificationState,3250);assert.equal(actual.features.provenanceQuality,3500);assert.ok(ranked.rankedCandidates.length<=64);t.diagnostic(JSON.stringify({rankedRecordId:actual.item!.id,verificationState:actual.features.verificationState,provenanceQuality:actual.features.provenanceQuality}));}finally{image.close();}
  const adapter=createVerifiedReadAdapter(binding);
  try{
    const response=await adapter.query({operation:"get-canonical-record",consistency:"session-strong",minimumEventPosition:receipt.terminalPosition,budgetMs:5000,parameters:{id:receipt.recordId,visibility:"session"}});
    assert.equal(response.content.operation,"get-canonical-record"); if(response.content.operation!=="get-canonical-record")throw new Error("wrong operation"); assert.ok(response.content.item); assert.equal(response.content.item.id,receipt.recordId); assert.equal(response.content.item.status,"candidate"); assert.equal(response.content.item.textKind,"canonical-summary"); assert.equal(response.content.item.sourceEventPosition,receipt.terminalPosition); assert.equal("recordKind" in response.content.item,false); assert.equal("verificationStatus" in response.content.item,false);
    assert.equal(response.content.item.text,"g10unique [REDACTED]");assert.equal(response.content.item.kind,"canonical");assert.equal(response.content.item.confidence,"low");assert.equal(response.content.item.verificationMethod,"governed-note-unverified-v1");assert.equal(response.content.item.sessionId,receipt.scope.sessionId);assert.equal(response.receipt.requiredEventPosition,receipt.terminalPosition);assert.equal(response.receipt.verification,"image-scope-position-and-active-admission");assert.equal(response.receipt.releaseId,binding.expectedRelease.releaseId);
    for(const operation of ["search-projected-content","build-context-pack"] as const){const ranked=await adapter.query({operation,consistency:"session-strong",minimumEventPosition:receipt.terminalPosition,budgetMs:5000,parameters:{query:"g10unique",visibility:"session"}});assert.equal(ranked.content.operation,operation);if(ranked.content.operation!=="search-projected-content"&&ranked.content.operation!=="build-context-pack")throw new Error("wrong ranked operation");assert.equal(ranked.content.rankingPolicyVersion,"retrieval-ranking-v2-shadow-fixed-units");assert.ok(ranked.content.items.some(item=>item.id===receipt.recordId&&item.status==="candidate"));assert.equal(ranked.content.candidateBounded,false);assert.equal("explain"in ranked.content,false);}
    t.diagnostic(JSON.stringify({actualVerifiedReadReceipt:response.receipt,projectionBinding:binding.projectionBinding,noteSession:binding.session,deploymentIdentity:binding.deploymentDirectory,projectionIdentity:binding.projectionDirectory,manifestHash:createHash("sha256").update(readFileSync(join(binding.projectionDirectory.canonicalPath,PROJECTION_MANIFEST_FILENAME))).digest("hex"),actualReadArtifactHash:createHash("sha256").update(readFileSync(join(binding.deploymentDirectory.canonicalPath,"v2-internal-verified-read.js"))).digest("hex"),syntheticStoredRelease:binding.expectedRelease}));
    const before=fixture.observations().createPosts;
    await assert.rejects(adapter.query({operation:"get-canonical-record",consistency:"session-strong",minimumEventPosition:(BigInt(receipt.terminalPosition)+1n).toString(),budgetMs:5000,parameters:{id:receipt.recordId,visibility:"session"}}));assert.equal(fixture.observations().createPosts,before);
    assert.equal(JSON.stringify(response).includes("fixture_secret"),false);
  }finally{await adapter.close();}
 }finally{await fixture?.cleanup();}
});


test("injected detached companion corruption never projects through actual builder",{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture({scenario:"corrupt-companion"});try{
  const command={version:1 as const,operation:"create-governed-note" as const,commandId:randomUUID(),idempotencyKey:randomUUID(),recordKind:"mistake" as const,summary:"g10unique safe",confidence:"low" as const,provenance:[{kind:"retained-evidence" as const,identity:f.sourceId}]};
  const receipt=await f.run.create(f.permit,await f.prepareCreate(command));await assert.rejects(f.verifiedReadBinding(receipt),error=>error instanceof Error&&error.message==="INTEGRITY_FAILURE");
 }finally{await f.cleanup();}
});

test("v2 full-body candidate stays summary-only on ordinary routes over actual schema3 image",{timeout:120000},async(t)=>{
 const f=await makeGovernedNoteFixtureV2();const adapter:{value?:ReturnType<typeof createVerifiedReadAdapter>}={};
 try{
  const command={version:2 as const,operation:"create-governed-note" as const,commandId:randomUUID(),idempotencyKey:randomUUID(),recordKind:"adr" as const,summary:"g11unique fixture_secret",confidence:"low" as const,provenance:[{kind:"retained-evidence" as const,identity:f.sourceId}],content:{format:"markdown" as const,body:"# Decision\n\nBODYONLY marker fixture_secret\n"}};
  const receipt=await f.run.createV2(f.permit,await f.prepareCreateV2(command));assert.equal(receipt.resultVersion,2);
  const binding=await f.verifiedReadBinding(receipt);
  const manifest=parseProjectionManifestV3(JSON.parse(readFileSync(join(binding.projectionDirectory.canonicalPath,PROJECTION_MANIFEST_FILENAME),"utf8")),binding.projectionBinding);assert.equal(manifest.schemaVersion,3);
  adapter.value=createVerifiedReadAdapter(binding);
  const response=await adapter.value.query({operation:"get-canonical-record",consistency:"session-strong",minimumEventPosition:receipt.terminalPosition,budgetMs:5000,parameters:{id:receipt.recordId,visibility:"session"}});
  if(response.content.operation!=="get-canonical-record")throw new Error("wrong operation");assert.ok(response.content.item);
  assert.equal(response.content.item.text,"g11unique [REDACTED]");assert.equal(response.content.item.verificationMethod,"governed-note-unverified-v2");assert.equal(response.content.item.status,"candidate");
  for(const key of ["recordKind","bodyAvailability","content","verificationStatus"])assert.equal(key in response.content.item,false);
  assert.equal(response.receipt.imageSha256,manifest.databaseSha256);assert.equal("projectionSchemaVersion" in response.receipt,false);
  for(const operation of ["search-projected-content","build-context-pack"] as const){const ranked=await adapter.value.query({operation,consistency:"session-strong",minimumEventPosition:receipt.terminalPosition,budgetMs:5000,parameters:{query:"g11unique",visibility:"session"}});if(ranked.content.operation!=="search-projected-content"&&ranked.content.operation!=="build-context-pack")throw new Error("wrong ranked operation");assert.ok(ranked.content.items.some(item=>item.id===receipt.recordId));assert.equal(JSON.stringify(ranked).includes("BODYONLY"),false);}
  const body=await adapter.value.query({operation:"search-projected-content",consistency:"session-strong",minimumEventPosition:receipt.terminalPosition,budgetMs:5000,parameters:{query:"BODYONLY",visibility:"session"}});
  if(body.content.operation!=="search-projected-content")throw new Error("wrong operation");assert.equal(body.content.items.some(item=>item.id===receipt.recordId),false,"body is not ordinary retrieval text");
  assert.equal(JSON.stringify(response).includes("BODYONLY"),false);assert.equal(JSON.stringify(response).includes("fixture_secret"),false);
  assert.equal((await adapter.value.close()).cleanup,"complete");
  t.diagnostic(JSON.stringify({caseId:"v2-schema3-ordinary-summary-only",recordId:receipt.recordId,projectionSchemaVersion:manifest.schemaVersion,projectionGeneration:manifest.generation,terminalPosition:receipt.terminalPosition}));
 }finally{await adapter.value?.close();await f.cleanup();}
});
