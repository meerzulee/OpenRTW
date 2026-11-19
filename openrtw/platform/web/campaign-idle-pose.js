import { loadCasAnimation } from '/cas-animation.js';
import {
  assembleCampaignStandingPose,
  campaignStandingPosePolicy,
} from '/campaign-standing-pose.js';

// A source-backed static idle frame replaces the raw bind pose when the exact
// selected SG01 clip and strat_named_with_army skeleton are available. The pose
// maths remain the separately tested Hamilton candidate; native playback, blend
// selection and skeleton/model scale composition are not established here.
export async function loadCampaignIdlePose(
  core,
  model,
  assets,
  { isOpen = () => true, signal } = {}
) {
  if (typeof isOpen !== 'function') throw TypeError('Invalid idle-pose lifetime check');
  const open = () => {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException('Idle pose cancelled', 'AbortError');
    if (!isOpen()) throw new DOMException('Idle pose loading closed', 'AbortError');
  };
  open();
  try {
    if (!assets || typeof assets.load !== 'function')
      throw Error('Standing source assets are unavailable');
    const { clipBytes, skeletonBinding } = await assets.load({ signal });
    open();
    const clip = await loadCasAnimation(core, clipBytes, { isOpen });
    open();
    const candidate = await assembleCampaignStandingPose({
      frame: clip.frame(0),
      model,
      skeleton: skeletonBinding,
      policy: campaignStandingPosePolicy,
    });
    open();
    return Object.freeze({
      model: Object.freeze({
        ...model,
        geometry: candidate.geometry,
        presentationPolicy: candidate.presentationPolicy,
      }),
      status: Object.freeze({
        schema: 'openrtw-campaign-idle-pose-v1',
        state: 'active',
        frameIndex: 0,
        vertices: 587,
        nativeAnimation: false,
        sourceSha256: candidate.pose.sourceSha256,
        presentationPolicy: candidate.presentationPolicy,
      }),
    });
  } catch (error) {
    // Cancellation is never converted into a successful fallback publication.
    open();
    if (error?.name === 'AbortError') throw error;
    return Object.freeze({
      model,
      status: Object.freeze({
        schema: 'openrtw-campaign-idle-pose-v1',
        state: 'fallback',
        fallback: 'source-bind-pose',
        reason: String(error?.message ?? error).slice(0, 512),
        nativeAnimation: false,
      }),
    });
  }
}
