// Build the exported reduced-fraction JSON document.
import { derivedStats } from './moments.js';

const fstr = (f) => f.toString(); // Fraction already reduced with positive denom

export function buildExport(region, image, result, sourceName = '') {
  const stats = derivedStats(result.totals);
  const doc = {
    schema: 'clipped-raster-moments/1',
    source: sourceName || undefined,
    image: { width: image.width, height: image.height, maxval: image.maxval },
    units: {
      coordinates: '1/16 pixel (integers)',
      moments: 'pixel units, Mij = integral of gray * x^i * y^j over the in-image region area',
      fractions: 'reduced p/q strings, positive denominator',
    },
    region,
    moments: {
      M00: fstr(result.totals.M00),
      M10: fstr(result.totals.M10),
      M01: fstr(result.totals.M01),
      M20: fstr(result.totals.M20),
      M02: fstr(result.totals.M02),
      M11: fstr(result.totals.M11),
    },
    centroid: stats.centroid
      ? { x: fstr(stats.centroid.x), y: fstr(stats.centroid.y) }
      : null,
    covariance: stats.covariance
      ? {
          xx: fstr(stats.covariance.xx),
          yy: fstr(stats.covariance.yy),
          xy: fstr(stats.covariance.xy),
        }
      : null,
    coveredCells: result.cellCount,
    coveredArea: fstr(result.coveredArea),
  };
  return doc;
}
