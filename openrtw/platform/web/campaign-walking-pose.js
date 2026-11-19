import { loadCasAnimation } from '/cas-animation.js';
import {
  assembleCampaignStandingPose,
  assembleCampaignMarchPose,
  campaignStandingPosePolicy,
  campaignMarchPosePolicy,
  campaignMarchPoseSources,
} from '/campaign-standing-pose.js';

// Original owned SG03 limb keys with the existing bounded skeleton/CAS basis.
// Source root stride drives cadence; committed route interpolation owns XZ.
// Native animation selection, timing/blending and scale composition are unproved.
export async function loadCampaignWalkingPose(
  core,
  model,
  assets,
  { isOpen = () => true, signal } = {}
) {
  if (typeof isOpen !== 'function') throw TypeError('Invalid walking-pose lifetime check');
  const open = () => {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException('Walking pose cancelled', 'AbortError');
    if (!isOpen()) throw new DOMException('Walking pose loading closed', 'AbortError');
  };
  open();
  try {
    if (!assets || typeof assets.loadMarch !== 'function' || typeof assets.load !== 'function')
      throw Error('Optional source marching assets are unavailable');
    const [marchSource, idleSource] = await Promise.all([
      assets.loadMarch({ signal }),
      assets.load({ signal }),
    ]);
    open();
    const idle = await loadCasAnimation(core, idleSource.clipBytes, { isOpen });
    open();
    const standing = await assembleCampaignStandingPose({
      frame: idle.frame(0),
      model,
      skeleton: idleSource.skeletonBinding,
      policy: campaignStandingPosePolicy,
    });
    open();
    const bounds = standing.pose.bounds,
      normalization = {
        center: bounds[0].map((v, k) => (v + bounds[1][k]) / 2),
        extent: Math.max(...bounds[0].map((v, k) => bounds[1][k] - v)),
      };
    const clip = await loadCasAnimation(core, marchSource.clipBytes, {
      isOpen,
      expectedSha256: campaignMarchPoseSources.sha256,
    });
    open();
    const frames = [];
    for (let frameIndex = 0; frameIndex < 21; frameIndex++) {
      const result = await assembleCampaignMarchPose({
        frame: clip.frame(frameIndex),
        model,
        skeleton: marchSource.skeletonBinding,
        policy: campaignMarchPosePolicy,
        normalization,
      });
      open();
      frames.push(result.geometry);
    }
    const number = (bits) => {
        const v = new DataView(new ArrayBuffer(4));
        v.setUint32(0, bits, true);
        return v.getFloat32(0, true);
      },
      first = clip.frame(0).controlPositionBits.map(number),
      last = clip.frame(20).controlPositionBits.map(number),
      strideLength =
        (Math.hypot(last[0] - first[0], last[2] - first[2]) * 2.1) / normalization.extent;
    if (!Number.isFinite(strideLength) || strideLength < 0.01 || strideLength > 10)
      throw Error('Source march stride is outside the bounded presentation domain');
    const walking = Object.freeze({
      schema: 'openrtw-campaign-walking-frames-v1',
      sourceSha256: campaignMarchPoseSources.sha256,
      frames: Object.freeze(frames),
      strideLength,
      cycleSeconds: 20 / 30,
      policy: campaignMarchPosePolicy,
    });
    return Object.freeze({
      model: Object.freeze({ ...model, walking }),
      status: Object.freeze({
        schema: 'openrtw-campaign-walking-pose-v1',
        state: 'active',
        frameCount: 21,
        uniqueLoopFrames: 20,
        sourceSha256: campaignMarchPoseSources.sha256,
        strideLength,
        cadence: 'distance/source-root-stride;30Hz-only-when-distance-unavailable',
        cycleSeconds: walking.cycleSeconds,
        nativeAnimation: false,
        policy: campaignMarchPosePolicy,
      }),
    });
  } catch (error) {
    open();
    if (error?.name === 'AbortError') throw error;
    return Object.freeze({
      model,
      status: Object.freeze({
        schema: 'openrtw-campaign-walking-pose-v1',
        state: 'fallback',
        fallback: 'static-source-pose-with-continuous-travel',
        reason: String(error?.message ?? error).slice(0, 512),
        nativeAnimation: false,
      }),
    });
  }
}
