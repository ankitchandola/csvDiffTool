// CSV headers are user data, so they can be "__proto__" or "constructor".
// Plain object literals inherit those names; these dictionaries don't.
export function emptyDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

export function ownValue<T>(dict: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(dict, key) ? dict[key] : undefined
}
