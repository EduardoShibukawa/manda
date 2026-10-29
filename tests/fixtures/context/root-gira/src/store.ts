import { greet } from "./app";

export interface Store {
  get(key: string): string;
}

export class MemoryStore implements Store {
  private data = new Map<string, string>();

  get(key: string): string {
    return this.data.get(key) ?? "";
  }

  set(key: string, value: string): void {
    this.data.set(key, value);
  }
}

export function describe(store: Store, name: string): string {
  return greet(name) + " " + store.get("k");
}
