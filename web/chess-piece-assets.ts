import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Color, PieceType } from '../replay/schema.ts';

export const CHESS_PIECE_TYPES: readonly PieceType[] = [
  'king',
  'queen',
  'rook',
  'bishop',
  'knight',
  'pawn',
];

export const CLASSIC_CC0_ASSET_BASE_PATH = '/assets/chess/classic-cc0';

export const PIECE_REFERENCE_HEIGHT = 1.36;
export const PAWN_WIDTH_SCALE = 0.75;
export const BISHOP_HEIGHT_SCALE = 1.2;

function pieceFootprint(scene: THREE.Object3D): number {
  const bounds = new THREE.Box3().setFromObject(scene);
  const size = bounds.getSize(new THREE.Vector3());
  return Math.max(size.x, size.z);
}

const pieceAssetFiles: Readonly<Record<PieceType, string>> = {
  king: 'king.glb',
  queen: 'queen.glb',
  rook: 'rook.glb',
  bishop: 'bishop.glb',
  knight: 'knight.glb',
  pawn: 'pawn.glb',
};

export type PieceAssetLoadState = 'idle' | 'loading' | 'ready' | 'degraded' | 'unavailable';

export interface PieceAssetLoadResult {
  readonly loaded: readonly PieceType[];
  readonly failed: ReadonlyMap<PieceType, string>;
}

export interface PieceAssetMaterials {
  readonly piece: THREE.Material;
}

export interface PieceAssetLoader {
  loadAsync(url: string): Promise<{ readonly scene: THREE.Object3D }>;
}

export function pieceAssetFile(pieceType: PieceType): string {
  return pieceAssetFiles[pieceType];
}

export function pieceAssetUrl(pieceType: PieceType, basePath = CLASSIC_CC0_ASSET_BASE_PATH): string {
  return `${basePath.replace(/\/$/, '')}/${pieceAssetFile(pieceType)}`;
}

export function pieceVisualAssetId(pieceType: PieceType): string {
  return `classic-cc0-${pieceType}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function disposeObjectResources(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  });
}

/** Loads and normalizes one shared prototype per canonical chess piece type. */
export class ChessPieceAssetLibrary {
  private readonly loader: PieceAssetLoader;
  private readonly basePath: string;
  private readonly prototypes = new Map<PieceType, THREE.Object3D>();
  private readonly sourceMaterials = new Set<THREE.Material>();
  private loadPromise: Promise<PieceAssetLoadResult> | null = null;
  private loadStateValue: PieceAssetLoadState = 'idle';

  constructor(basePath = CLASSIC_CC0_ASSET_BASE_PATH, loader: PieceAssetLoader = new GLTFLoader()) {
    this.basePath = basePath;
    this.loader = loader;
  }

  get loadState(): PieceAssetLoadState {
    return this.loadStateValue;
  }

  load(): Promise<PieceAssetLoadResult> {
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadStateValue = 'loading';
    this.loadPromise = Promise.allSettled(CHESS_PIECE_TYPES.map((pieceType) =>
      this.loader.loadAsync(pieceAssetUrl(pieceType, this.basePath))
        .then((gltf) => ({ pieceType, scene: gltf.scene }))
    )).then((results) => {
      const loaded: PieceType[] = [];
      const failed = new Map<PieceType, string>();
      const queen = results.find((result) => result.status === 'fulfilled' && result.value.pieceType === 'queen');
      const queenScene = queen?.status === 'fulfilled' ? queen.value.scene : null;
      const queenWidth = queenScene === null ? null : pieceFootprint(queenScene);
      const queenHeight = queenScene === null ? null : new THREE.Box3().setFromObject(queenScene).getSize(new THREE.Vector3()).y;
      const queenReferenceWidth = queenWidth === null || queenHeight === null || queenHeight <= 0
        ? null
        : queenWidth * (PIECE_REFERENCE_HEIGHT / queenHeight);

      results.forEach((result, index) => {
        const pieceType = CHESS_PIECE_TYPES[index];
        if (result.status === 'fulfilled') {
          this.prototypes.set(pieceType, this.normalizePrototype(result.value.scene, pieceType, queenReferenceWidth));
          loaded.push(pieceType);
        } else failed.set(pieceType, errorMessage(result.reason));
      });
      this.loadStateValue = loaded.length === CHESS_PIECE_TYPES.length ? 'ready' : 'degraded';
      return { loaded, failed };
    });
    return this.loadPromise;
  }

  getPrototype(pieceType: PieceType): THREE.Object3D | null {
    return this.prototypes.get(pieceType) ?? null;
  }

  createPieceVisual(
    pieceType: PieceType,
    color: Color,
    materials: PieceAssetMaterials,
  ): THREE.Object3D | null {
    const prototype = this.getPrototype(pieceType);
    if (prototype === null) return null;
    const visual = prototype.clone(true);
    visual.name = `model:${color}-${pieceType}`;
    visual.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.material = materials.piece;
      object.castShadow = true;
      object.receiveShadow = true;
    });
    return visual;
  }

  dispose(): void {
    for (const prototype of this.prototypes.values()) disposeObjectResources(prototype);
    for (const material of this.sourceMaterials) material.dispose();
    this.prototypes.clear();
    this.sourceMaterials.clear();
    this.loadPromise = null;
    this.loadStateValue = 'idle';
  }

  private normalizePrototype(scene: THREE.Object3D, pieceType: PieceType, queenReferenceWidth: number | null): THREE.Object3D {
    scene.updateMatrixWorld(true);
    const initialBounds = new THREE.Box3().setFromObject(scene);
    const initialSize = initialBounds.getSize(new THREE.Vector3());
    if (!Number.isFinite(initialSize.y) || initialSize.y <= 0) {
      throw new Error('Chess piece model has no measurable height');
    }

    // Keep the source GLBs untouched. The king keeps height-based sizing; all
    // other pieces share the queen's normalized footprint on the board.
    const scale = pieceType === 'king' || queenReferenceWidth === null
      ? PIECE_REFERENCE_HEIGHT / initialSize.y
      : queenReferenceWidth / Math.max(initialSize.x, initialSize.z);
    scene.scale.multiplyScalar(scale);
    if (pieceType === 'pawn') {
      scene.scale.x *= PAWN_WIDTH_SCALE;
      scene.scale.z *= PAWN_WIDTH_SCALE;
    } else if (pieceType === 'bishop') {
      scene.scale.y *= BISHOP_HEIGHT_SCALE;
    }
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(scene);
    const center = bounds.getCenter(new THREE.Vector3());
    scene.position.x -= center.x;
    scene.position.z -= center.z;
    scene.position.y -= bounds.min.y;
    scene.updateMatrixWorld(true);

    let meshCount = 0;
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshCount += 1;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) this.sourceMaterials.add(material);
    });
    if (meshCount === 0) throw new Error('Chess piece model contains no mesh');
    return scene;
  }
}

export function fallbackAssetRequired(
  library: Pick<ChessPieceAssetLibrary, 'getPrototype'>,
  pieceType: PieceType,
): boolean {
  return library.getPrototype(pieceType) === null;
}
