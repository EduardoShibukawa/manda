export function allocTaskIds(taken: string[], count: number): string[] {
  const nums: number[] = [];
  for (const t of taken) {
    const m = /^T(\d+)$/.exec(t);
    if (m) {
      nums.push(parseInt(m[1], 10));
    }
  }
  if (nums.length === 0) {
    const res: string[] = [];
    for (let i = 1; i <= count; i++) {
      res.push(`T${i}`);
    }
    return res;
  }
  let next = Math.max(...nums) + 1;
  const res: string[] = [];
  for (let i = 0; i < count; i++) {
    res.push(`T${next++}`);
  }
  return res;
}
