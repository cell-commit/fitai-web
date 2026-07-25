import { describe, it, expect } from 'vitest';
import { PROGRAM_SCHEMA, PLAN_STYLE_RULES } from '../program';
import { REVIEW_SCHEMA } from '../programReview';
import { COACH_TOOLS } from '../coach';

// Cheap regression guard for the CONCISENESS-AT-THE-SOURCE work: the app's plan
// and review surfaces are read on a phone mid-workout, so the word limits live
// in the schema descriptions + prompt style block rather than being trimmed in
// the UI. If someone rewrites a description and drops a limit, these fail.

function prop(schema: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let node = schema;
  for (const key of path) {
    node = (node as Record<string, Record<string, unknown>>)[key];
    expect(node, `missing schema node: ${path.join('.')}`).toBeTruthy();
  }
  return node;
}

function description(schema: Record<string, unknown>, path: string[]): string {
  const d = prop(schema, path).description;
  expect(typeof d, `no description at ${path.join('.')}`).toBe('string');
  return d as string;
}

describe('PROGRAM_SCHEMA copy limits', () => {
  const dayProps = ['properties', 'days', 'items', 'properties'];

  it('day title is capped at 4 words with no parentheticals', () => {
    const d = description(PROGRAM_SCHEMA, [...dayProps, 'title']);
    expect(d).toMatch(/4 words/);
    expect(d).toMatch(/parenthetical/i);
  });

  it('coachNotes is capped at 30 words and asks for an imperative cue', () => {
    const d = description(PROGRAM_SCHEMA, [...dayProps, 'coachNotes']);
    expect(d).toMatch(/30 words/);
    expect(d).toMatch(/imperative/i);
  });

  it('exercise notes are capped at 12 words', () => {
    const d = description(PROGRAM_SCHEMA, [
      ...dayProps,
      'exercises',
      'items',
      'properties',
      'notes',
    ]);
    expect(d).toMatch(/12 words/);
  });

  it('rationale is capped at 20 words', () => {
    expect(description(PROGRAM_SCHEMA, ['properties', 'rationale'])).toMatch(
      /20 words/
    );
  });
});

describe('PLAN_STYLE_RULES prompt block', () => {
  it('states every limit and sends long-form text to the chat reply', () => {
    expect(PLAN_STYLE_RULES).toMatch(/4 words/);
    expect(PLAN_STYLE_RULES).toMatch(/30 words/);
    expect(PLAN_STYLE_RULES).toMatch(/12 words/);
    expect(PLAN_STYLE_RULES).toMatch(/20 words/);
    expect(PLAN_STYLE_RULES).toMatch(/chat reply/i);
  });
});

describe('update_weekly_program tool copy limits', () => {
  it('repeats the limits in the tool description', () => {
    const tool = COACH_TOOLS.find((t) => t.name === 'update_weekly_program');
    expect(tool).toBeTruthy();
    const d = tool!.description;
    expect(d).toMatch(/4 words/);
    expect(d).toMatch(/30 words/);
    expect(d).toMatch(/12 words/);
  });

  it('carries the shared PROGRAM_SCHEMA so the field limits apply', () => {
    const tool = COACH_TOOLS.find((t) => t.name === 'update_weekly_program')!;
    const week = (tool.input_schema as Record<string, Record<string, unknown>>)
      .properties.week;
    expect(week).toBe(PROGRAM_SCHEMA);
  });
});

describe('REVIEW_SCHEMA copy limits', () => {
  it('summary is one sentence of at most 20 words', () => {
    const d = description(REVIEW_SCHEMA, ['properties', 'summary']);
    expect(d).toMatch(/20 words/);
    expect(d).toMatch(/one sentence/i);
  });

  it('concern issue and suggestion are capped at 15 telegraphic words', () => {
    const base = ['properties', 'concerns', 'items', 'properties'];
    const issue = description(REVIEW_SCHEMA, [...base, 'issue']);
    const suggestion = description(REVIEW_SCHEMA, [...base, 'suggestion']);
    expect(issue).toMatch(/15 words/);
    expect(issue).toMatch(/telegraphic/i);
    expect(suggestion).toMatch(/15 words/);
    expect(suggestion).toMatch(/telegraphic/i);
  });
});
