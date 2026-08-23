// Float comparison utilities with epsilon tolerance
// Used for deterministic float equality checks in tests

const DEFAULT_EPSILON = 1e-9;

/**
 * Compare two floats with epsilon tolerance.
 * 
 * @param a First float
 * @param b Second float
 * @param epsilon Tolerance (default 1e-9)
 * @returns True if floats are equal within epsilon
 */
export function floatEq(a: number, b: number, epsilon: number = DEFAULT_EPSILON): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return a === b;
  }
  
  const diff = Math.abs(a - b);
  return diff <= epsilon;
}

/**
 * Deep equality for objects with float fields.
 * Recursively compares all numeric fields with epsilon tolerance.
 * 
 * @param objA First object
 * @param objB Second object
 * @param epsilon Tolerance (default 1e-9)
 * @returns True if objects are equal (floats within epsilon)
 */
export function deepFloatEq(
  objA: unknown,
  objB: unknown,
  epsilon: number = DEFAULT_EPSILON
): boolean {
  if (objA === objB) {
    return true;
  }

  if (objA === null || objB === null || objA === undefined || objB === undefined) {
    return objA === objB;
  }

  if (typeof objA !== typeof objB) {
    return false;
  }

  if (typeof objA === "number" && typeof objB === "number") {
    return floatEq(objA, objB, epsilon);
  }

  if (Array.isArray(objA) && Array.isArray(objB)) {
    if (objA.length !== objB.length) {
      return false;
    }
    return objA.every((item, index) => deepFloatEq(item, objB[index], epsilon));
  }

  if (typeof objA === "object" && typeof objB === "object") {
    const keysA = Object.keys(objA);
    const keysB = Object.keys(objB);

    if (keysA.length !== keysB.length) {
      return false;
    }

    return keysA.every((key) => {
      const valueA = (objA as Record<string, unknown>)[key];
      const valueB = (objB as Record<string, unknown>)[key];
      return deepFloatEq(valueA, valueB, epsilon);
    });
  }

  return objA === objB;
}

/**
 * Assert two floats are equal with epsilon tolerance.
 * Throws if not equal.
 */
export function assertFloatEq(a: number, b: number, epsilon: number = DEFAULT_EPSILON): void {
  if (!floatEq(a, b, epsilon)) {
    throw new Error(`Floats not equal: ${a} vs ${b} (epsilon: ${epsilon})`);
  }
}

/**
 * Assert two objects are deeply equal with float tolerance.
 * Throws if not equal.
 */
export function assertDeepFloatEq(
  objA: unknown,
  objB: unknown,
  epsilon: number = DEFAULT_EPSILON
): void {
  if (!deepFloatEq(objA, objB, epsilon)) {
    throw new Error(
      `Objects not equal: ${JSON.stringify(objA)} vs ${JSON.stringify(objB)} (epsilon: ${epsilon})`
    );
  }
}
