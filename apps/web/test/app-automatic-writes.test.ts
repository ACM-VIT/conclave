import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type Violation = { path: string; line: number; reason: string; write: string };

const SDK_DIR = fileURLToPath(new URL("../../../packages/apps-sdk/", import.meta.url));
const APPS_DIR = join(SDK_DIR, "src", "apps");

const TIMER_AND_EFFECT_CALLS = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "queueMicrotask",
  "requestIdleCallback",
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
]);
const PROMISE_CONTINUATIONS = new Set(["then", "catch", "finally"]);
const SYNCHRONOUS_CALLBACKS = new Set(["forEach", "map", "flatMap", "filter", "some", "every", "find", "findIndex", "reduce", "sort", "transact"]);
const AUTOMATIC_DOM_EVENTS = [
  "onEnded",
  "onError",
  "onLoad",
  "onLoadedData",
  "onLoadedMetadata",
  "onCanPlay",
  "onCanPlayThrough",
  "onProgress",
  "onSeeked",
  "onSeeking",
  "onWaiting",
  "onStalled",
  "onPlaying",
  "onTimeUpdate",
  "onDurationChange",
  "onAnimationStart",
  "onAnimationEnd",
  "onTransitionEnd",
];
const USER_EVENT_TYPES = new Set([
  "click",
  "dblclick",
  "contextmenu",
  "keydown",
  "keyup",
  "pointerdown",
  "pointermove",
  "pointerup",
  "mousedown",
  "mousemove",
  "mouseup",
  "touchstart",
  "touchmove",
  "touchend",
  "wheel",
  "paste",
  "drop",
  "input",
  "change",
  "submit",
]);
const YJS_MUTATIONS = new Set(["transact", "set", "insert", "delete", "push", "unshift", "applyDelta", "format"]);

const ALLOWED: Array<{ file: string; inside: string; why: string }> = [
  {
    file: join("whiteboard", "web", "components", "WhiteboardCanvas.tsx"),
    inside: "runStressTest",
    why: "dev-only synthetic load generator behind ?wbStress, never reachable in a call",
  },
];

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowJs: false,
};

const walk = (node: ts.Node, visit: (node: ts.Node) => boolean | void): void => {
  if (visit(node) === false) return;
  node.forEachChild((child) => walk(child, visit));
};

const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);

const calleeName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
};

const argumentOf = (node: ts.Node): ts.CallExpression | null =>
  node.parent && ts.isCallExpression(node.parent) && node.parent.arguments.includes(node as ts.Expression) ? node.parent : null;

const isWriteOnceCallback = (node: ts.Node): boolean => {
  const call = argumentOf(node);
  return isFunction(node) && call !== null && calleeName(call) === "writeOnce";
};

const callbackPropName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && /^on[A-Z]/.test(callee.text)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === "current" && ts.isIdentifier(callee.expression)) {
      const match = /^(on[A-Z]\w*)Ref$/.exec(callee.expression.text);
      if (match) return match[1];
    }
    if (/^on[A-Z]/.test(callee.name.text) && ts.isIdentifier(callee.expression) && callee.expression.text === "props") {
      return callee.name.text;
    }
  }
  return null;
};

const writeAnalysis = (program: ts.Program) => {
  const checker = program.getTypeChecker();

  const functionOf = (declaration: ts.Node | undefined, seen = new Set<ts.Node>()): ts.Node | null => {
    if (!declaration || seen.has(declaration)) return null;
    seen.add(declaration);
    if (isFunction(declaration)) return declaration;
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const value = checker.getShorthandAssignmentValueSymbol(declaration);
      return functionOf(value?.valueDeclaration ?? value?.declarations?.[0], seen);
    }
    if (ts.isPropertyAssignment(declaration)) return functionOfExpression(declaration.initializer, seen);
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const init = declaration.initializer;
      if (ts.isCallExpression(init) && calleeName(init) === "useCallback") return functionOfExpression(init.arguments[0], seen);
      if (ts.isCallExpression(init) && calleeName(init) === "useMemo" && init.arguments[0] && ts.isArrowFunction(init.arguments[0])) {
        return functionOfExpression(init.arguments[0].body as ts.Expression, seen);
      }
      return functionOfExpression(init, seen);
    }
    return null;
  };

  const functionOfExpression = (expression: ts.Expression | undefined, seen = new Set<ts.Node>()): ts.Node | null => {
    if (!expression) return null;
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const resolved = functionOf(symbol?.valueDeclaration ?? symbol?.declarations?.[0], seen);
      if (resolved || !ts.isPropertyAccessExpression(expression)) return resolved;
      return memberReturnedByHook(expression, seen);
    }
    return null;
  };

  const memberReturnedByHook = (access: ts.PropertyAccessExpression, seen: Set<ts.Node>): ts.Node | null => {
    if (!ts.isIdentifier(access.expression)) return null;
    const holder = checker.getSymbolAtLocation(access.expression)?.valueDeclaration;
    if (!holder || !ts.isVariableDeclaration(holder) || !holder.initializer || !ts.isCallExpression(holder.initializer)) return null;
    const hook = functionOfExpression(holder.initializer.expression, seen);
    if (!hook || !isFunction(hook) || !hook.body) return null;
    let member: ts.Node | null = null;
    walk(hook.body, (node) => {
      if (member || (node !== hook.body && isFunction(node))) return false;
      if (!ts.isReturnStatement(node) || !node.expression || !ts.isObjectLiteralExpression(node.expression)) return;
      const property = node.expression.properties.find((candidate) => candidate.name?.getText() === access.name.text);
      member = property ? functionOf(property, seen) : null;
    });
    return member;
  };

  const isYjsMutation = (call: ts.CallExpression): boolean => {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || !YJS_MUTATIONS.has(callee.name.text)) return false;
    const symbol = checker.getTypeAtLocation(callee.expression).getSymbol();
    return (symbol?.declarations ?? []).some((declaration) => declaration.getSourceFile().fileName.includes(`${sep}yjs${sep}`));
  };

  const writerMemo = new Map<ts.Node, string | null>();
  const writesWhenCalled = (fn: ts.Node): string | null => {
    if (writerMemo.has(fn)) return writerMemo.get(fn)!;
    writerMemo.set(fn, null);
    let found: string | null = null;
    const body = isFunction(fn) ? fn.body : fn;
    if (body) {
      walk(body, (node) => {
        if (found) return false;
        if (isFunction(node)) {
          const call = argumentOf(node);
          if (!call || !SYNCHRONOUS_CALLBACKS.has(calleeName(call) ?? "")) return false;
        }
        if (ts.isCallExpression(node)) found = writeCallName(node);
      });
    }
    writerMemo.set(fn, found);
    return found;
  };

  const writeCallName = (call: ts.CallExpression): string | null => {
    if (isYjsMutation(call)) return `.${calleeName(call)}`;
    const target = functionOfExpression(call.expression);
    return target && writesWhenCalled(target) ? calleeName(call) : null;
  };

  return { functionOfExpression, writesWhenCalled, writeCallName, isYjsMutation };
};

export const findAutomaticWrites = (program: ts.Program, isAppFile: (path: string) => boolean): Violation[] => {
  const { functionOfExpression, writesWhenCalled, writeCallName } = writeAnalysis(program);

  const registeredListenerType = (fn: ts.Node, call: ts.CallExpression | null): string | null | undefined => {
    const typeOf = (registration: ts.CallExpression) => {
      const type = registration.arguments[0];
      return type && ts.isStringLiteralLike(type) ? type.text : null;
    };
    if (call && calleeName(call) === "addEventListener") return typeOf(call);
    const declaration = fn.parent;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return undefined;
    const listener = declaration.name.text;
    let scope: ts.Node | undefined = declaration.parent;
    while (scope && !isFunction(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    let found: string | null | undefined;
    if (scope) {
      walk(scope, (inner) => {
        if (found !== undefined) return false;
        if (
          ts.isCallExpression(inner) &&
          calleeName(inner) === "addEventListener" &&
          inner.arguments[1] &&
          ts.isIdentifier(inner.arguments[1]) &&
          inner.arguments[1].text === listener
        ) {
          found = typeOf(inner);
        }
      });
    }
    return found;
  };

  const automaticReason = (node: ts.Node, automaticProps: Set<string>): string | null => {
    const writePos = node.getStart();
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (isWriteOnceCallback(current)) return null;
      if (!isFunction(current)) continue;
      const call = argumentOf(current);
      const name = call ? calleeName(call) : null;
      const listenerType = registeredListenerType(current, call);
      if (listenerType !== undefined) {
        if (listenerType !== null && USER_EVENT_TYPES.has(listenerType)) return null;
        return `inside a ${listenerType ?? "dom"} listener`;
      }
      if (name && TIMER_AND_EFFECT_CALLS.has(name)) return `inside ${name}`;
      if (name && PROMISE_CONTINUATIONS.has(name)) return `inside .${name}`;
      const parent = current.parent;
      if (parent && ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "Promise") {
        return "inside a Promise executor";
      }
      if (parent && ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) {
        const attribute = parent.parent.name.getText();
        if (automaticProps.has(attribute)) return `inside ${attribute}`;
      }
      let awaitedBefore = false;
      walk(current, (inner) => {
        if (inner !== current && isFunction(inner)) return false;
        if (ts.isAwaitExpression(inner) && inner.getEnd() <= writePos) awaitedBefore = true;
      });
      if (awaitedBefore) return "after an await";
    }
    return null;
  };

  const renderedDirectly = (call: ts.Node): boolean => {
    let enclosing: ts.Node | undefined = call.parent;
    while (enclosing && !isFunction(enclosing)) enclosing = enclosing.parent;
    if (!enclosing) return true;
    const declaration = enclosing.parent;
    const name =
      ts.isFunctionDeclaration(enclosing) && enclosing.name
        ? enclosing.name.text
        : declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
          ? declaration.name.text
          : null;
    return name !== null && /^([A-Z]|use[A-Z])/.test(name);
  };

  const allowed = (path: string, node: ts.Node, write: string): boolean =>
    ALLOWED.some((entry) => {
      if (!path.endsWith(entry.file)) return false;
      if (write === entry.inside) return true;
      for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.name.text === entry.inside) return true;
      }
      return false;
    });

  const automaticParamsMemo = new Map<ts.Node, Map<number, string>>();
  const automaticParamsOf = (fn: ts.Node, automaticProps: Set<string>): Map<number, string> => {
    const known = automaticParamsMemo.get(fn);
    if (known) return known;
    const params = new Map<number, string>();
    automaticParamsMemo.set(fn, params);
    if (!isFunction(fn) || !fn.body) return params;
    fn.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) return;
      const name = parameter.name.text;
      walk(fn.body!, (node) => {
        if (params.has(index)) return false;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
          const reason = automaticReason(node, automaticProps);
          if (reason) params.set(index, reason);
        }
      });
    });
    return params;
  };

  const appFiles = program.getSourceFiles().filter((file) => isAppFile(file.fileName));
  const automaticProps = new Set(AUTOMATIC_DOM_EVENTS);
  for (const file of appFiles) {
    walk(file, (node) => {
      if (!ts.isCallExpression(node)) return;
      const prop = callbackPropName(node);
      if (prop && automaticReason(node, new Set())) automaticProps.add(prop);
    });
  }

  const violations: Violation[] = [];
  for (const file of appFiles) {
    const report = (node: ts.Node, reason: string, write: string) => {
      if (allowed(file.fileName, node, write)) return;
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      violations.push({ path: relative(APPS_DIR, file.fileName), line: line + 1, reason, write });
    };
    const reportWriterReference = (expression: ts.Expression | undefined, reason: string) => {
      if (!expression || (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression))) return;
      const target = functionOfExpression(expression);
      if (target && writesWhenCalled(target)) report(expression, reason, expression.getText());
    };
    walk(file, (node) => {
      if (ts.isCallExpression(node)) {
        const write = writeCallName(node);
        if (write) {
          const reason = automaticReason(node, automaticProps) ?? (renderedDirectly(node) ? "during render" : null);
          if (reason) report(node, reason, write);
        }
        const name = calleeName(node);
        if (name && (TIMER_AND_EFFECT_CALLS.has(name) || PROMISE_CONTINUATIONS.has(name))) {
          for (const argument of node.arguments) reportWriterReference(argument, `passed to ${name}`);
        }
        const target = functionOfExpression(node.expression);
        if (target) {
          for (const [index, reason] of automaticParamsOf(target, automaticProps)) {
            const argument = node.arguments[index];
            if (!argument) continue;
            const handed = `handed to ${name ?? "a function"}, which calls it ${reason}`;
            if ((ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) && writesWhenCalled(argument)) {
              report(argument, handed, writesWhenCalled(argument)!);
            } else {
              reportWriterReference(argument, handed);
            }
          }
        }
      }
      if (ts.isJsxAttribute(node) && automaticProps.has(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer)) {
        reportWriterReference(node.initializer.expression, `wired to ${node.name.getText()}`);
      }
    });
  }
  return violations;
};

type SplitChange = { path: string; line: number; writes: number };

const LOOPS = new Set([ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement]);
const SHORT_CIRCUITS = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

const ends = (statement: ts.Statement | undefined): boolean => {
  if (!statement) return false;
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) return ends(statement.statements.at(-1));
  if (ts.isIfStatement(statement)) return ends(statement.thenStatement) && ends(statement.elseStatement);
  return false;
};

export const findSplitChanges = (program: ts.Program, isAppFile: (path: string) => boolean): SplitChange[] => {
  const { writeCallName, isYjsMutation, functionOfExpression } = writeAnalysis(program);

  const allowedFunction = (fn: ts.Node): boolean => {
    const path = fn.getSourceFile().fileName;
    for (let current: ts.Node | undefined = fn; current; current = current.parent) {
      if (!ts.isVariableDeclaration(current)) continue;
      const name = current.name.getText();
      if (ALLOWED.some((entry) => path.endsWith(entry.file) && entry.inside === name)) return true;
    }
    return false;
  };

  const pathMemo = new Map<ts.Node, number>();
  const writesOf = (fn: ts.Node): number => {
    if (pathMemo.has(fn)) return pathMemo.get(fn)!;
    pathMemo.set(fn, 1);
    if (allowedFunction(fn)) return 1;
    const body = isFunction(fn) ? fn.body : undefined;
    const writes = !body ? 1 : ts.isBlock(body) ? writesAlong(body.statements, 0) : writesOn(body);
    pathMemo.set(fn, writes);
    return writes;
  };

  const writesOn = (node: ts.Node | undefined): number => {
    if (!node) return 0;
    if (isFunction(node)) {
      const wrapper = node.parent && ts.isParenthesizedExpression(node.parent) ? node.parent : node;
      if (wrapper.parent && ts.isCallExpression(wrapper.parent) && wrapper.parent.expression === wrapper) return writesOf(node);
      const call = argumentOf(node);
      const name = call ? calleeName(call) : null;
      return name && name !== "transact" && SYNCHRONOUS_CALLBACKS.has(name) ? 2 * writesOn(node.body) : 0;
    }
    if (ts.isBlock(node)) return writesAlong(node.statements, 0);
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const [test, yes, no] = ts.isIfStatement(node)
        ? [node.expression, node.thenStatement, node.elseStatement]
        : [node.condition, node.whenTrue, node.whenFalse];
      return writesOn(test) + Math.max(writesOn(yes), writesOn(no));
    }
    if (ts.isSwitchStatement(node)) {
      return writesOn(node.expression) + Math.max(0, ...node.caseBlock.clauses.map((clause) => writesAlong(clause.statements, 0)));
    }
    if (ts.isBinaryExpression(node) && SHORT_CIRCUITS.has(node.operatorToken.kind)) return writesOn(node.left) + writesOn(node.right);
    let own = 0;
    if (ts.isCallExpression(node) && writeCallName(node)) {
      if (isYjsMutation(node)) {
        if (calleeName(node) === "transact") return 1;
        own = 1;
      } else {
        const target = functionOfExpression(node.expression);
        own = target ? Math.max(1, writesOf(target)) : 1;
      }
    }
    let inner = 0;
    node.forEachChild((child) => {
      inner += writesOn(child);
    });
    return own + (LOOPS.has(node.kind) ? 2 * inner : inner);
  };

  const writesAlong = (statements: ts.NodeArray<ts.Statement> | ts.Statement[], from: number): number => {
    const statement = statements[from];
    if (!statement) return 0;
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return writesOn(statement.expression);
    const rest = () => writesAlong(statements, from + 1);
    if (ts.isIfStatement(statement)) {
      const test = writesOn(statement.expression);
      const yes = writesOn(statement.thenStatement) + (ends(statement.thenStatement) ? 0 : rest());
      const no = writesOn(statement.elseStatement) + (ends(statement.elseStatement) ? 0 : rest());
      return test + Math.max(yes, no);
    }
    return writesOn(statement) + rest();
  };

  const runsInOneTransaction = (fn: ts.Node): boolean => {
    const call = argumentOf(fn);
    return call !== null && ["transact", "writeOnce"].includes(calleeName(call) ?? "");
  };

  const exported = (fn: ts.Node): boolean => {
    const holder = ts.isFunctionDeclaration(fn) ? fn : fn.parent?.parent?.parent;
    return !!holder && ts.canHaveModifiers(holder) && !!ts.getModifiers(holder)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  };
  const entryPoint = (path: string, fn: ts.Node): boolean => !relative(APPS_DIR, path).split(sep).includes("core") || exported(fn);

  const changes: SplitChange[] = [];
  for (const file of program.getSourceFiles().filter((candidate) => isAppFile(candidate.fileName))) {
    walk(file, (fn) => {
      if (!isFunction(fn) || !fn.body || runsInOneTransaction(fn) || allowedFunction(fn)) return;
      if (!entryPoint(file.fileName, fn)) return;
      const writes = writesOf(fn);
      if (writes < 2) return;
      const { line } = file.getLineAndCharacterOfPosition(fn.getStart());
      changes.push({ path: relative(APPS_DIR, file.fileName), line: line + 1, writes });
    });
  }
  return changes;
};

const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });

const isWebOrShared = (path: string): boolean => {
  const parts = relative(APPS_DIR, path).split(sep);
  return !parts[0]?.startsWith("..") && ["web", "shared"].includes(parts[1] ?? "");
};

const FIXTURE_DIR = join(SDK_DIR, "src", "__automatic_write_fixtures__");
const FIXTURE_CORE = `
  import * as Y from "yjs";
  export const save = (doc: Y.Doc, value: number) => { doc.transact(() => doc.getMap("m").set("v", value)); };
  export const read = (doc: Y.Doc) => { const seen: number[] = []; seen.push(1); return doc.getMap("m").get("v"); };
`;
const FIXTURE_PRELUDE = `
  import * as Y from "yjs";
  import { save, read } from "./core";
  declare const useEffect: (effect: () => void, deps?: unknown[]) => void;
  declare const writeOnce: (key: string, write: (doc: Y.Doc) => void) => void;
  void read;
`;

const fixtureProgram = (fixtures: string[]) => {
  const files = new Map<string, string>([[join(FIXTURE_DIR, "core.ts"), FIXTURE_CORE]]);
  fixtures.forEach((body, index) => files.set(join(FIXTURE_DIR, `fixture${index}.tsx`), FIXTURE_PRELUDE + body));
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    files.has(fileName)
      ? ts.createSourceFile(fileName, files.get(fileName)!, languageVersion, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      : getSourceFile(fileName, languageVersion, onError, shouldCreate);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => files.has(fileName) || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => files.get(fileName) ?? readFile(fileName);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (directory) => directory === FIXTURE_DIR || (directoryExists?.(directory) ?? false);
  return ts.createProgram([...files.keys()], COMPILER_OPTIONS, host);
};

const CAUGHT: Array<[string, string, string]> = [
  ["a timer", `export function App({ doc }: { doc: Y.Doc }) { const go = () => setTimeout(() => save(doc, 1), 10); return <button onClick={go} />; }`, "inside setTimeout"],
  ["an effect", `export function App({ doc }: { doc: Y.Doc }) { useEffect(() => { save(doc, 1); }, [doc]); return null; }`, "inside useEffect"],
  ["a promise continuation", `export function App({ doc }: { doc: Y.Doc }) { const go = () => fetch("x").then(() => save(doc, 1)); return <button onClick={go} />; }`, "inside .then"],
  ["a media event", `export function App({ doc }: { doc: Y.Doc }) { return <video onEnded={() => save(doc, 1)} />; }`, "inside onEnded"],
  ["code after an await", `export function App({ doc }: { doc: Y.Doc }) { const go = async () => { await fetch("x"); save(doc, 1); }; return <button onClick={go} />; }`, "after an await"],
  ["render", `export function App({ doc }: { doc: Y.Doc }) { save(doc, 1); return null; }`, "during render"],
  [
    "a media listener added in an effect",
    `export function App({ doc, video }: { doc: Y.Doc; video: HTMLVideoElement }) { useEffect(() => { video.addEventListener("ended", () => save(doc, 1)); }, [video]); return null; }`,
    "inside a ended listener",
  ],
  [
    "a callback a helper calls from a promise",
    `const later = (write: (value: number) => void) => { void fetch("x").then(() => write(1)); };
     export function App({ doc }: { doc: Y.Doc }) { const go = () => later((value) => save(doc, value)); return <button onClick={go} />; }`,
    "handed to later, which calls it inside .then",
  ],
  [
    "a hook member wired to a media event",
    `type Handle = { onEnded: () => void };
     function usePlayback(doc: Y.Doc): Handle { const onEnded = () => save(doc, 1); return { onEnded }; }
     export function App({ doc }: { doc: Y.Doc }) { const player = usePlayback(doc); return <video onEnded={player.onEnded} />; }`,
    "wired to onEnded",
  ],
  ["an animation frame given a writer", `export function App({ doc }: { doc: Y.Doc }) { const flush = () => save(doc, 1); const go = () => requestAnimationFrame(flush); return <button onClick={go} />; }`, "passed to requestAnimationFrame"],
  [
    "a prop a child calls from an effect",
    `function Child({ onSettled }: { onSettled: () => void }) { useEffect(() => { onSettled(); }, []); return null; }
     export function App({ doc }: { doc: Y.Doc }) { const settle = () => save(doc, 1); return <Child onSettled={settle} />; }`,
    "wired to onSettled",
  ],
];
const ALLOWED_FIXTURES: Array<[string, string]> = [
  ["a click", `export function App({ doc }: { doc: Y.Doc }) { return <button onClick={() => save(doc, 1)} />; }`],
  ["writeOnce from a timer", `export function App() { useEffect(() => { setTimeout(() => writeOnce("k", (live) => save(live, 1)), 10); }, []); return null; }`],
  [
    "a keyboard listener added in an effect",
    `export function App({ doc }: { doc: Y.Doc }) { useEffect(() => { const onKey = () => save(doc, 1); window.addEventListener("keydown", onKey); }, [doc]); return null; }`,
  ],
  ["a read that fills a local array", `export function App({ doc }: { doc: Y.Doc }) { useEffect(() => { read(doc); }, [doc]); return null; }`],
];

const SPLIT_FIXTURES: Array<[string, string, number]> = [
  ["two writes in a row", `export const move = (doc: Y.Doc) => { doc.getArray("a").delete(0, 1); doc.getArray("a").insert(0, [1]); };`, 2],
  ["a write in a loop", `export const fill = (doc: Y.Doc, values: number[]) => { for (const value of values) doc.getArray("a").push([value]); };`, 2],
  ["a helper that writes twice", `const twice = (doc: Y.Doc) => { doc.getMap("m").set("a", 1); doc.getMap("m").set("b", 2); };
     export function App({ doc }: { doc: Y.Doc }) { return <button onClick={() => twice(doc)} />; }`, 2],
  ["two whole changes from one click", `export function App({ doc }: { doc: Y.Doc }) { return <button onClick={() => { save(doc, 1); save(doc, 2); }} />; }`, 2],
  ["a function it calls in place", `export const move = (doc: Y.Doc) => { save(doc, 1); (() => save(doc, 2))(); };`, 2],
  ["one transaction", `export const move = (doc: Y.Doc) => { doc.transact(() => { doc.getArray("a").delete(0, 1); doc.getArray("a").insert(0, [1]); }); };`, 0],
  ["one of two branches", `export const pick = (doc: Y.Doc, left: boolean) => { if (left) { save(doc, 1); return; } save(doc, 2); };`, 0],
  ["a writeOnce callback", `export function App() { useEffect(() => { writeOnce("k", (live) => { save(live, 1); save(live, 2); }); }, []); return null; }`, 0],
];

describe("automatic document writes", () => {
  it("only ever happen through writeOnce in every app", () => {
    const files = sourcesUnder(APPS_DIR);
    const program = ts.createProgram(files, COMPILER_OPTIONS);
    expect(files.filter(isWebOrShared).length).toBeGreaterThan(10);

    expect(findAutomaticWrites(program, isWebOrShared)).toEqual([]);
  }, 60_000);

  it("each go to the server whole, in one transaction", () => {
    const files = sourcesUnder(APPS_DIR);
    const program = ts.createProgram(files, COMPILER_OPTIONS);
    const isApp = (path: string) => !relative(APPS_DIR, path).startsWith("..");

    expect(findSplitChanges(program, isApp)).toEqual([]);
  }, 60_000);

  it("count the writes along the busiest path a change can take", () => {
    const program = fixtureProgram(SPLIT_FIXTURES.map(([, body]) => body));
    const changes = findSplitChanges(program, (path) => path.startsWith(FIXTURE_DIR) && !path.endsWith("core.ts"));

    SPLIT_FIXTURES.forEach(([what, , writes], index) =>
      expect({
        what,
        writes: Math.max(0, ...changes.filter((change) => change.path.endsWith(`fixture${index}.tsx`)).map((change) => change.writes)),
      }).toEqual({ what, writes }),
    );
  }, 60_000);

  it("are caught from timers, effects, promises, media events, awaits, render and props called from effects, and allowed otherwise", () => {
    const program = fixtureProgram([...CAUGHT.map(([, body]) => body), ...ALLOWED_FIXTURES.map(([, body]) => body)]);
    const violations = findAutomaticWrites(program, (path) => path.startsWith(FIXTURE_DIR) && !path.endsWith("core.ts"));
    const byFixture = (index: number) =>
      violations.filter((violation) => violation.path.endsWith(`fixture${index}.tsx`)).map((violation) => violation.reason);

    CAUGHT.forEach(([what, , reason], index) => expect({ what, reasons: byFixture(index) }).toEqual({ what, reasons: [reason] }));
    ALLOWED_FIXTURES.forEach(([what], offset) =>
      expect({ what, reasons: byFixture(CAUGHT.length + offset) }).toEqual({ what, reasons: [] }),
    );
  }, 60_000);
});
