// Activities carry identifiers only (EXE-2). Each returns a tagged string so outputs show the path taken.
export async function stepA(id) { return `A:${id}`; }
export async function stepA2(id) { return `A2:${id}`; }
export async function stepB(id) { return `B:${id}`; }
export async function stepC(id) { return `C:${id}`; }
