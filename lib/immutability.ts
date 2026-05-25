/**
 * IMMUTABILITY UTILITIES - Production-grade freezing and mutation detection
 *
 * Core principle: Cards are created once per execution cycle and NEVER mutated.
 * All downstream consumers receive frozen, cloned copies.
 */

/**
 * Deep freeze an object recursively
 * Prevents any mutations at any depth
 */
export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  // Freeze the object itself
  Object.freeze(obj);

  // Recursively freeze all properties
  Object.getOwnPropertyNames(obj).forEach((prop) => {
    const value = (obj as any)[prop];
    
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  });

  return obj;
}

/**
 * Safe card cloning + freezing pattern
 * MUST be used when passing cards across boundaries
 */
export function safeFreezeCard<T extends Record<string, any>>(card: T): T {
  // Clone to prevent shared references
  const cloned = structuredClone(card);
  // Deep freeze to prevent mutations
  return deepFreeze(cloned);
}

/**
 * Mutation detection via Proxy
 * Add to cards temporarily for debugging
 */
export function createMutationDetector<T extends Record<string, any>>(
  obj: T,
  name: string = "object"
): T {
  const handler = {
    set(target: any, prop: string | symbol, value: any) {
      console.warn(
        `[MUTATION_DETECTED] ${name}.${String(prop)} = ${JSON.stringify(value)}`
      );
      console.trace(`[MUTATION_STACK] Setting ${String(prop)}`);
      return Reflect.set(target, prop, value);
    },
  };

  return new Proxy(obj, handler);
}

/**
 * Verify an object is properly frozen
 * Returns true only if object and all nested objects are frozen
 */
export function isDeepFrozen(obj: any, checked = new WeakSet()): boolean {
  // Prevent infinite loops
  if (checked.has(obj)) return true;
  
  if (obj === null || typeof obj !== "object") return true;
  
  if (!Object.isFrozen(obj)) return false;
  
  checked.add(obj);
  
  // Check all properties are also frozen
  for (const prop of Object.getOwnPropertyNames(obj)) {
    const value = obj[prop];
    if (value && typeof value === "object") {
      if (!isDeepFrozen(value, checked)) {
        return false;
      }
    }
  }
  
  return true;
}

/**
 * Assert a card is properly frozen, throw if not
 * Use at immutability boundaries for enforcement
 */
export function assertDeepFrozen(obj: any, name: string = "object"): void {
  if (!isDeepFrozen(obj)) {
    throw new Error(
      `[IMMUTABILITY_VIOLATION] ${name} is not properly deep frozen. ` +
      `Mutation after execution boundary detected.`
    );
  }
}
