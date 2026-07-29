import 'three';

declare module 'three' {
  export class RoundedBoxGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, depth?: number, segments?: number, radius?: number);
  }
}
