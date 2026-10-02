import AsyncStorage from "@react-native-async-storage/async-storage";
import type { RemoteDesktopDisplayMode } from "@cindy/device-link";

// Non-secret, phone-local: the last display choice this phone made for one
// monitor of one computer. The host still restores its own display on
// disconnect. "fit" keeps the virtual display size and the phone viewport it
// was fitted to, so the next connection can create it before any video.
type Size = { width: number; height: number };
export type RememberedResolution =
  | ({ kind: "mode"; modeId: string } & Size)
  | ({ kind: "fit"; viewport: Size } & Size);

let writes: Promise<void> = Promise.resolve();
const storageKey = (deviceId: string, displayId: string) =>
  `cindy.mobile.remote-desktop.resolution.v1.${encodeURIComponent(deviceId)}.${encodeURIComponent(displayId)}`;

/** `null` forgets the choice, so the computer keeps its own display next time. */
export function rememberResolution(
  deviceId: string,
  displayId: string,
  value: RememberedResolution | null,
): Promise<void> {
  const key = storageKey(deviceId, displayId);
  writes = writes
    .then(() =>
      value
        ? AsyncStorage.setItem(key, JSON.stringify(value))
        : AsyncStorage.removeItem(key),
    )
    .catch(() => undefined);
  return writes;
}

export async function readRememberedResolution(
  deviceId: string,
  displayId: string,
): Promise<RememberedResolution | null> {
  try {
    await writes;
    const raw = await AsyncStorage.getItem(storageKey(deviceId, displayId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    const size = (item: unknown): Size | null => {
      const { width, height } = (item ?? {}) as Record<string, unknown>;
      return Number.isInteger(width) &&
        Number.isInteger(height) &&
        (width as number) > 0 &&
        (height as number) > 0
        ? { width: width as number, height: height as number }
        : null;
    };
    const display = size(value);
    if (!display) return null;
    if (value?.kind === "mode" && typeof value.modeId === "string")
      return { kind: "mode", modeId: value.modeId, ...display };
    const viewport = size(value?.viewport);
    return value?.kind === "fit" && viewport
      ? { kind: "fit", viewport, ...display }
      : null;
  } catch {
    return null;
  }
}

/** Mode IDs may change after OS or monitor updates; fall back to the same size. */
export function findRememberedMode(
  modes: RemoteDesktopDisplayMode[],
  remembered: { modeId: string } & Size,
): RemoteDesktopDisplayMode | undefined {
  const sameSize = (mode: RemoteDesktopDisplayMode) =>
    mode.width === remembered.width && mode.height === remembered.height;
  return (
    modes.find((mode) => mode.id === remembered.modeId && sameSize(mode)) ??
    modes.find(sameSize)
  );
}
