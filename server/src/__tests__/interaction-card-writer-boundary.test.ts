import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parseSync, Visitor, type Node } from "oxc-parser";

const table = "issueThreadInteractions";
const writer = "server/src/services/interaction-card-status.ts";
const relevant = new Set(["status", "effectiveResolverPolicy", "addresseeAgentId", "addresseeUserId", "issueId", "companyId"]);

const root = fileURLToPath(new URL("../../../", import.meta.url));

function* productionFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "__tests__") yield* productionFiles(file);
    if (entry.isFile() && entry.name.endsWith(".ts") && !/\.(?:test|spec|fixture|d)\.ts$/.test(entry.name)) yield file;
  }
}

function name(node: Node | null | undefined): string | undefined {
  return node?.type === "Identifier" ? node.name : node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function modifiesWipFields(node: Node | undefined): boolean {
  if (node?.type === "ObjectExpression") return node.properties.some(property => property.type === "SpreadElement"
    ? modifiesWipFields(property.argument)
    : (property.computed && property.key.type !== "Literal") || relevant.has(name(property.key) ?? ""));
  if (node?.type === "ConditionalExpression") return modifiesWipFields(node.consequent) || modifiesWipFields(node.alternate);
  if (node?.type === "ParenthesizedExpression" || node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression") {
    return modifiesWipFields(node.expression);
  }
  return true;
}

function isCardTable(node: Node | undefined, aliases: Set<string>): boolean {
  return aliases.has(name(node) ?? "") || (node?.type === "MemberExpression" && name(node.property) === table);
}

function isCardInsert(node: Node | undefined, aliases: Set<string>, builders: Set<string>): boolean {
  if (builders.has(name(node) ?? "")) return true;
  if (node?.type !== "CallExpression" || node.callee.type !== "MemberExpression") return false;
  const { object, property } = node.callee;
  return (name(property) === "insert" && isCardTable(node.arguments[0], aliases)) || isCardInsert(object, aliases, builders);
}

function findWrites(file: string, source: string): string[] {
  const parsed = parseSync(file, source);
  assert.deepEqual(parsed.errors, [], `Parse ${file}`);
  const aliases = new Set([table]);
  const insertBuilders = new Set<string>();
  const initializers: Array<[string, Node]> = [];
  const metadataUpdates = new Set<number>();
  const writes: string[] = [];
  const report = (node: Node, operation: string) => writes.push(`${file}:${source.slice(0, node.start).split("\n").length} ${operation}`);
  const checkSql = (node: Node, sql: string) => {
    if (/\b(?:update|delete\s+from|insert\s+into)\s+(?:(?:"?\w+"?)\.)?"?issue_thread_interactions\b/i.test(sql)) report(node, "raw SQL");
  };
  new Visitor({
    ImportSpecifier(node) { if (name(node.imported) === table) aliases.add(node.local.name); },
    VariableDeclarator(node) { if (node.id.type === "Identifier" && node.init) initializers.push([node.id.name, node.init]); },
  }).visit(parsed.program);
  let discovered = true;
  while (discovered) {
    const size = aliases.size + insertBuilders.size;
    for (const [binding, value] of initializers) {
      if (isCardTable(value, aliases)) aliases.add(binding);
      if (isCardInsert(value, aliases, insertBuilders)) insertBuilders.add(binding);
    }
    discovered = aliases.size + insertBuilders.size > size;
  }
  new Visitor({ CallExpression(node) {
    if (node.callee.type !== "MemberExpression" || name(node.callee.property) !== "set") return;
    const update = node.callee.object;
    if (update.type === "CallExpression" && update.callee.type === "MemberExpression" && name(update.callee.property) === "update"
        && !modifiesWipFields(node.arguments[0])) metadataUpdates.add(update.start);
  } }).visit(parsed.program);
  new Visitor({
    CallExpression(node) {
      if (node.callee.type !== "MemberExpression") return;
      const { object, property } = node.callee;
      const method = name(property);
      if (method === "update" && isCardTable(node.arguments[0], aliases) && !metadataUpdates.has(node.start)) report(node, "update");
      if (method === "delete" && isCardTable(node.arguments[0], aliases)) report(node, "delete");
      if (method === "onConflictDoUpdate" && isCardInsert(object, aliases, insertBuilders)) {
        const config = node.arguments[0];
        const set = config?.type === "ObjectExpression" && config.properties.find(property => property.type === "Property" && name(property.key) === "set");
        if (!set || set.type !== "Property" || modifiesWipFields(set.value)) report(node, "upsert");
      }
      if (method === "raw" || method === "execute" || method === "query") {
        const literal = node.arguments[0];
        if (literal?.type === "Literal" && typeof literal.value === "string") checkSql(node, literal.value);
      }
    },
    TaggedTemplateExpression(node) {
      const sql = node.quasi.quasis.map(part => part.value.raw).reduce((text, part, index) => {
        const expression = node.quasi.expressions[index - 1];
        return `${text}${isCardTable(expression, aliases) ? "issue_thread_interactions" : ""}${part}`;
      }, "");
      checkSql(node, sql);
    },
  }).visit(parsed.program);
  return writes;
}

test("card writer scan detects split builders, table member access and literal SQL", () => {
  const source = [
    "const metadata = db.update(schema.issueThreadInteractions).set({ result });",
    "const unsafe = db.update(schema.issueThreadInteractions);",
    "unsafe.set({ status: 'expired' });",
    "const cards = schema.issueThreadInteractions;",
    "const insert = db.insert(cards).values(values);",
    "insert.onConflictDoUpdate({ set: { status: 'expired' } });",
    'db.execute(sql.raw(\'UPDATE "public"."issue_thread_interactions" SET status = NULL\'));',
    'db.execute("DELETE FROM issue_thread_interactions");',
  ].join("\n");
  assert.deepEqual(findWrites("fixture.ts", source), [
    "fixture.ts:2 update", "fixture.ts:6 upsert", "fixture.ts:7 raw SQL", "fixture.ts:8 raw SQL",
  ]);
});

// Checks Drizzle calls, named imports, local aliases and direct literal/tagged SQL in runtime TypeScript.
// It does not resolve dynamic SQL construction or data passed across module boundaries.
// Plain insert cannot withdraw existing WIP protection. Migration SQL is outside runtime scope.
test("runtime Drizzle and tagged SQL card lifecycle writes use the shared admission writer", () => {
  const sources = [...productionFiles("server/src"), ...productionFiles("packages/db/src")];
  const bypasses = sources.sort().filter(file => file !== writer).flatMap(file => {
    const source = readFileSync(join(root, file), "utf8");
    return /issueThreadInteractions|issue_thread_interactions/.test(source) ? findWrites(file, source) : [];
  });
  assert.deepEqual(bypasses, [], `Card lifecycle writes outside ${writer}`);
});
