import type { FeatureId } from "./featureCatalog";
import { featureProperties } from "./featureCatalog";
import { telemetry } from "./runtime";

const EXPOSED_FEATURE_SESSION_PREFIX = "study-buddy:telemetry:feature-exposed:v1:";
const capturedFeatures = new Set<FeatureId>();
const pendingFeatures = new Set<FeatureId>();

function markerKey(feature: FeatureId): string {
  return `${EXPOSED_FEATURE_SESSION_PREFIX}${feature}`;
}

function hasSessionMarker(feature: FeatureId): boolean {
  try {
    return window.sessionStorage.getItem(markerKey(feature)) === "1";
  } catch {
    return false;
  }
}

function setSessionMarker(feature: FeatureId): void {
  try {
    window.sessionStorage.setItem(markerKey(feature), "1");
  } catch {
    // The in-memory guard still prevents duplicate exposures when storage is unavailable.
  }
}

/** Captures at most one exposure per app session, including across route and component remounts. */
export async function captureFeatureExposureOnce(
  feature: FeatureId,
  surface: string,
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (capturedFeatures.has(feature) || pendingFeatures.has(feature) || hasSessionMarker(feature)) {
    return false;
  }
  pendingFeatures.add(feature);
  try {
    const captured = await telemetry.capture({
      event: "feature.exposed",
      properties: featureProperties(feature, { surface }),
    });
    if (captured) {
      capturedFeatures.add(feature);
      setSessionMarker(feature);
    }
    return captured;
  } finally {
    pendingFeatures.delete(feature);
  }
}
