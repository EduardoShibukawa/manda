import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * T909: a máquina de estados do PLAN mora no manda. `nextAction` é pura e o
 * verbo `manda next` a expõe por stdin/stdout para o `ginga tick`.
 */
const ROOT = join(import.meta.dir, "..");
const load = async (): Promise<any> => import(join(ROOT, "src", "next.ts"));
const task = (id: string, status: string, attempts = 0, deps_done = true) => ({ id: `PLAN-0001/${id}`, status, attempts, deps_done });

describe("nextAction", () => {
  test("approved → red", async () => {
    const { nextAction } = await load();
    expect(nextAction({ phase: "approved", tasks: [task("TASK-01", "open")], cap_ok: true }).cmd).toBe("red");
  });

  test("red/tasks com TASK aberta e dependências prontas → run dessa TASK", async () => {
    const { nextAction } = await load();
    for (const phase of ["red", "tasks"]) {
      const a = nextAction({ phase, tasks: [task("TASK-01", "pass"), task("TASK-02", "open")], cap_ok: true });
      expect(a).toMatchObject({ cmd: "run", plan: "PLAN-0001", task: "TASK-02" });
    }
  });

  test("TASK aberta com dependência pendente não roda", async () => {
    const { nextAction } = await load();
    expect(nextAction({ phase: "tasks", tasks: [task("TASK-02", "open", 0, false)], cap_ok: true }).cmd).toBe("none");
  });

  test("todas as TASKs pass → judge", async () => {
    const { nextAction } = await load();
    expect(nextAction({ phase: "tasks", tasks: [task("TASK-01", "pass"), task("TASK-02", "pass")], cap_ok: true }).cmd).toBe("judge");
  });

  test("TASK com 3 falhas → replan dela, antes de qualquer run", async () => {
    const { nextAction } = await load();
    const a = nextAction({ phase: "tasks", tasks: [task("TASK-01", "fail", 3), task("TASK-02", "open")], cap_ok: true });
    expect(a).toMatchObject({ cmd: "replan", task: "TASK-01" });
  });

  test("judge pass → merge; grave → replan; fail → replan; sem veredito → none", async () => {
    const { nextAction } = await load();
    const tasks = [task("TASK-01", "pass")];
    expect(nextAction({ phase: "judge", tasks, cap_ok: true, judge: "pass" }).cmd).toBe("merge");
    expect(nextAction({ phase: "judge", tasks, cap_ok: true, judge: "high" }).cmd).toBe("replan");
    expect(nextAction({ phase: "judge", tasks, cap_ok: true, judge: "fail" }).cmd).toBe("replan");
    expect(nextAction({ phase: "judge", tasks, cap_ok: true }).cmd).toBe("none");
  });

  test("sem capacidade → notify, em qualquer fase", async () => {
    const { nextAction } = await load();
    expect(nextAction({ phase: "approved", tasks: [task("TASK-01", "open")], cap_ok: false }).cmd).toBe("notify");
  });

  test("done e fase desconhecida → none", async () => {
    const { nextAction } = await load();
    expect(nextAction({ phase: "done", tasks: [], cap_ok: true }).cmd).toBe("none");
    expect(nextAction({ phase: "qualquer", tasks: [], cap_ok: true }).cmd).toBe("none");
  });
});

describe("manda next (CLI)", () => {
  const run = (stdin: string) => {
    const r = Bun.spawnSync([process.execPath, join(ROOT, "bin/manda.ts"), "next"], { stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString().trim() };
  };

  test("estado por stdin, ação em uma linha de JSON", () => {
    const r = run(JSON.stringify({ phase: "tasks", tasks: [task("TASK-01", "pass")], cap_ok: true }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ cmd: "judge", plan: "PLAN-0001" });
    expect(r.out.includes("\n")).toBe(false);
  });

  test("entrada que não é um estado válido → exit 2", () => {
    expect(run("isto não é json").code).toBe(2);
    expect(run(JSON.stringify({ tasks: [] })).code).toBe(2);
  });
});
