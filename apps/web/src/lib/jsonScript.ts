/**
 * JSON for embedding in an HTML `<script>` element. `JSON.stringify` leaves `<` alone, so
 * a string containing `</script>` would close the element and let the rest run as
 * markup; `\u003c`-style escapes are plain JSON that every parser decodes back. U+2028/
 * U+2029 are escaped too — legal in JSON but line terminators in older JS engines.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
