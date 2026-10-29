export function greet(name: string): string {
  return `ola, ${name}`;
}

export class Greeter {
  constructor(private prefix: string) {}

  shout(name: string): string {
    return `${this.prefix.toUpperCase()} ${greet(name)}`;
  }
}

export const DEFAULT_NAME = "mundo";
