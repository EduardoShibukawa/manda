import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyBlocked, type BlockedClass } from "../src/blocked";

/**
 * 8 fixtures, um por classe de BlockedClass (PLAN-0029 TASK-07).
 * Cada fixture contém um texto real de BLOCKED/falha de gate e o teste
 * verifica que classifyBlocked devolve a classe e ação exatas.
 */
const FIXTURES = [
  { file: "scope_drift.txt",          wantClass: "scope_drift",          wantAction: "retry_clean"    },
  { file: "id_collision.txt",          wantClass: "id_collision",          wantAction: "auto_unblock"   },
  { file: "quota.txt",                 wantClass: "quota",                 wantAction: "skip_tier"      },
  { file: "gate_false_positive.txt",   wantClass: "gate_false_positive",   wantAction: "replan"         },
  { file: "contract_conflict.txt",     wantClass: "contract_conflict",     wantAction: "replan"         },
  { file: "missing_dep.txt",           wantClass: "missing_dep",           wantAction: "retry_clean"    },
  { file: "env_dependency.txt",        wantClass: "env_dependency",        wantAction: "replan"         },
  { file: "other.txt",                 wantClass: "other",                 wantAction: "notify"         },
] as const satisfies ReadonlyArray<{ file: string; wantClass: BlockedClass; wantAction: string }>;

describe("classifyBlocked — fixtures por classe", () => {
  const dir = join(__dirname, "fixtures", "blocked");

  for (const f of FIXTURES) {
    test(`fixture ${f.file} → ${f.wantClass}/${f.wantAction}`, () => {
      const text = readFileSync(join(dir, f.file), "utf8");
      const r = classifyBlocked(text);
      expect(r.class).toBe(f.wantClass);
      expect(r.action).toBe(f.wantAction);
      expect(r.evidence).toBeTruthy();
    });
  }
});

describe("classifyBlocked — sem match", () => {
  test("texto sem padrão conhecido → other/notify", () => {
    const r = classifyBlocked("nada reconhecido aqui");
    expect(r.class).toBe("other");
    expect(r.action).toBe("notify");
  });
});

describe("classifyBlocked — prioridade de ordem", () => {
  test("o primeiro padrão que casa vence", () => {
    // contém __pycache__ (scope_drift) antes de qualquer outro padrão
    const r = classifyBlocked("__pycache__ encontrado, mas também usage limit");
    expect(r.class).toBe("scope_drift");
  });
});
