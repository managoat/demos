import { describe, expect, test } from "bun:test";
import { forgetRemembered, rememberPerson, rememberedPerson } from "./analytics";

function store() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("the remembered person", () => {
  test("survives a reload, so a returning viewer is identified on the first paint", () => {
    // Without this the app only knows who someone is after `me()` runs, and
    // `me()` runs at sign-in and from Settings — neither on an ordinary reload.
    // Everything recorded before it would be filed under an anonymous id.
    const s = store();
    rememberPerson("11111111-1111-1111-1111-111111111111", s);

    expect(rememberedPerson(s)).toBe("11111111-1111-1111-1111-111111111111");
  });

  test("sign-out forgets, so the next person is not recorded as the last one", () => {
    const s = store();
    rememberPerson("11111111-1111-1111-1111-111111111111", s);
    forgetRemembered(s);

    expect(rememberedPerson(s)).toBeNull();
  });

  test("an empty stored id reads as nobody, not as an account named \"\"", () => {
    const s = store();
    s.map.set("fountain-team.person", "");

    expect(rememberedPerson(s)).toBeNull();
  });

  test("a browser with storage blocked is anonymous rather than broken", () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };

    expect(rememberedPerson(blocked)).toBeNull();
    expect(() => rememberPerson("abc", blocked)).not.toThrow();
    expect(() => forgetRemembered(blocked)).not.toThrow();
  });
});
