/** Keep the Reviewer on the source task's device, including while reconnecting. */
export async function startReviewOnDevice(
  request: Parameters<Window['electronAPI']['maker']['startReview']>[0],
  remoteDeviceId?: string,
): Promise<void> {
  if (remoteDeviceId) {
    await window.electronAPI.deviceLink.invoke(remoteDeviceId, 'maker:review:start', [request]);
  } else {
    await window.electronAPI.maker.startReview(request);
  }
}
