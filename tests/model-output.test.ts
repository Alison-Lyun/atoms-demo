import { describe,it,expect } from 'vitest';
import { parseArtifactOutput } from '../src/lib/server/model';
const artifact={title:'待办',summary:'支持持久化',html:'<!doctype html><html><head><title>Todos</title></head><body><h1>Todos</h1></body></html>',dataSchemaVersion:1};
describe('gateway structured output compatibility',()=>{
  it('accepts one raw JSON object',()=>expect(parseArtifactOutput(JSON.stringify(artifact))).toEqual(artifact));
  it('accepts one fenced JSON object and still validates schema',()=>expect(parseArtifactOutput('```json\n'+JSON.stringify(artifact)+'\n```')).toEqual(artifact));
  it('does not extract arbitrary embedded JSON from prose',()=>expect(()=>parseArtifactOutput('Here is your app: '+JSON.stringify(artifact))).toThrow());
  it('does not bypass schema validation for fenced data',()=>expect(()=>parseArtifactOutput('```json\n{"html":"bad"}\n```')).toThrow());
});
