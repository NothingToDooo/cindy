// @vitest-environment jsdom
import AsyncStorage from "@react-native-async-storage/async-storage";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findRememberedMode,
  readRememberedResolution,
  rememberResolution,
} from "../resolutionMemory";

const key = "cindy.mobile.remote-desktop.resolution.v1.computer.display";
const modes = [
  { id: "a", width: 1920, height: 1080, current: true },
  { id: "b", width: 2560, height: 1440, current: false },
  { id: "c", width: 2560, height: 1440, current: false },
];

describe("remote desktop resolution memory", () => {
  beforeEach(async () => {
    await AsyncStorage.removeItem(key);
  });

  it("stores the choice per computer and monitor", async () => {
    const mode = {
      kind: "mode" as const,
      modeId: "b",
      width: 2560,
      height: 1440,
    };
    await rememberResolution("computer", "display", mode);
    expect(await readRememberedResolution("computer", "display")).toEqual(mode);
    expect(await readRememberedResolution("computer", "other")).toBeNull();
    expect(await readRememberedResolution("other", "display")).toBeNull();
  });

  it("remembers the fitted size with its viewport and forgets on restore", async () => {
    const fit = {
      kind: "fit" as const,
      width: 658,
      height: 1280,
      viewport: { width: 390, height: 760 },
    };
    await rememberResolution("computer", "display", fit);
    expect(await readRememberedResolution("computer", "display")).toEqual(fit);
    await rememberResolution("computer", "display", null);
    expect(await readRememberedResolution("computer", "display")).toBeNull();
  });

  it("ignores malformed stored values", async () => {
    await AsyncStorage.setItem(
      key,
      '{"kind":"mode","modeId":"b","width":"2560","height":1440}',
    );
    expect(await readRememberedResolution("computer", "display")).toBeNull();
    await AsyncStorage.setItem(key, '{"kind":"fit","width":658,"height":1280}');
    expect(await readRememberedResolution("computer", "display")).toBeNull();
    await AsyncStorage.setItem(key, "not json");
    expect(await readRememberedResolution("computer", "display")).toBeNull();
  });

  it("matches the same mode id, then falls back to the same size", () => {
    expect(
      findRememberedMode(modes, { modeId: "c", width: 2560, height: 1440 })?.id,
    ).toBe("c");
    expect(
      findRememberedMode(modes, { modeId: "gone", width: 2560, height: 1440 })
        ?.id,
    ).toBe("b");
    expect(
      findRememberedMode(modes, { modeId: "a", width: 3840, height: 2160 }),
    ).toBeUndefined();
  });
});
