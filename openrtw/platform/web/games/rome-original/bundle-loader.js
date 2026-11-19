import createCore from '/core/openrtw-core.mjs';
import { createRomeOriginalBundleLoader } from './bundle.js';

export const loadRomeOriginalBundle = createRomeOriginalBundleLoader({ createCore });
