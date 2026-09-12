import * as THREE from 'three';
import type { MoveRecord, PresentedPiece, PresentationSnapshot } from '../replay/presentation.ts';
import type { Color, PieceType } from '../replay/schema.ts';
import {
  createReplayAnimationModel,
  type AnimationPieceFrame,
  type ReplayAnimationFrame,
  type ReplayAnimationOptions,
} from './replay-animation.ts';

export const BOARD_SIZE = 8;
export const BOARD_SQUARE_COUNT = BOARD_SIZE * BOARD_SIZE;
export const CANONICAL_FILES = 'abcdefgh';
export const CANONICAL_RANKS = '12345678';

export type BoardOrientation = 'white' | 'black';
export type BoardOrientationInput = BoardOrientation | boolean;
export type BoardRendererStatus = 'unmounted' | 'webgl' | 'fallback' | 'unavailable';

export interface BoardCoordinate {
  readonly square: string;
  readonly file: number;
  readonly rank: number;
  readonly x: number;
  readonly z: number;
}

export interface BoardPieceProjection extends BoardCoordinate {
  readonly piece_identity: string;
  readonly piece_type: PieceType;
  readonly color: Color;
  readonly visual_asset_id: string;
}

export interface BoardSnapshotProjection {
  readonly orientation: BoardOrientation;
  readonly squareSize: number;
  readonly pieces: readonly BoardPieceProjection[];
  readonly occupancy: ReadonlyMap<string, BoardPieceProjection>;
  readonly identities: ReadonlyMap<string, BoardPieceProjection>;
}

export interface PieceIdentityUpdate {
  readonly piece_identity: string;
  readonly before: BoardPieceProjection | null;
  readonly after: BoardPieceProjection | null;
}

export interface FallbackAssetDescriptor {
  readonly kind: 'primitive-fallback';
  readonly piece_identity: string;
  readonly piece_type: PieceType;
  readonly color: Color;
  readonly visual_asset_id: string;
  readonly label: string;
}

export interface Board3DRendererOptions {
  readonly orientation?: BoardOrientationInput;
  readonly squareSize?: number;
  readonly backgroundColor?: THREE.ColorRepresentation;
  readonly antialias?: boolean;
  readonly rendererFactory?: (parameters: THREE.WebGLRendererParameters) => THREE.WebGLRenderer;
  readonly pieceAssetFactory?: (piece: PresentedPiece) => THREE.Object3D | null;
}

export interface BoardMountResult {
  readonly status: Exclude<BoardRendererStatus, 'unmounted'>;
  readonly error: string | null;
}

export interface BoardRenderResult {
  readonly status: Exclude<BoardRendererStatus, 'unmounted'>;
  readonly squareCount: number;
  readonly pieceCount: number;
  readonly fallbackAssetCount: number;
  readonly error: string | null;
}

export function boardRendererParameters(
  options: Pick<Board3DRendererOptions, 'antialias'> = {},
): THREE.WebGLRendererParameters {
  return {
    antialias: options.antialias ?? true,
    alpha: true,
    // Keep settled frames available to browser compositors and visual capture tools.
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  };
}

const pieceTypes: readonly PieceType[] = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];

function isPieceType(value: string): value is PieceType {
  return pieceTypes.includes(value as PieceType);
}

function orientationValue(input: BoardOrientationInput): BoardOrientation {
  return typeof input === 'boolean' ? (input ? 'black' : 'white') : input;
}

export function normalizeBoardOrientation(input: BoardOrientationInput = 'white'): BoardOrientation {
  const orientation = orientationValue(input);
  if (orientation !== 'white' && orientation !== 'black') {
    throw new Error('Board orientation must be white or black');
  }
  return orientation;
}

function assertSquare(square: string): void {
  if (!/^[a-h][1-8]$/.test(square)) throw new Error(`Invalid canonical board square: ${square}`);
}

export function canonicalSquareToIndex(square: string): number {
  assertSquare(square);
  return CANONICAL_FILES.indexOf(square[0]) + (Number(square[1]) - 1) * BOARD_SIZE;
}

export function indexToCanonicalSquare(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= BOARD_SQUARE_COUNT) {
    throw new Error(`Invalid canonical board index: ${index}`);
  }
  return CANONICAL_FILES[index % BOARD_SIZE] + CANONICAL_RANKS[Math.floor(index / BOARD_SIZE)];
}

export function canonicalBoardSquares(orientation: BoardOrientationInput = 'white'): string[] {
  const view = normalizeBoardOrientation(orientation);
  const files = view === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const ranks = view === 'white' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  return ranks.flatMap((rank) => files.map((file) => CANONICAL_FILES[file] + CANONICAL_RANKS[rank]));
}

export function canonicalSquareToBoardCoordinate(
  square: string,
  orientation: BoardOrientationInput = 'white',
  squareSize = 1,
): BoardCoordinate {
  const index = canonicalSquareToIndex(square);
  if (!Number.isFinite(squareSize) || squareSize <= 0) throw new Error('Board square size must be positive');
  const view = normalizeBoardOrientation(orientation);
  const file = index % BOARD_SIZE;
  const rank = Math.floor(index / BOARD_SIZE);
  const displayFile = view === 'white' ? file : BOARD_SIZE - 1 - file;
  const displayRank = view === 'white' ? rank : BOARD_SIZE - 1 - rank;
  const boardCenter = (BOARD_SIZE - 1) / 2;
  return {
    square,
    file,
    rank,
    x: (displayFile - boardCenter) * squareSize,
    z: (boardCenter - displayRank) * squareSize,
  };
}

export const squareToBoardCoordinate = canonicalSquareToBoardCoordinate;
export const boardPositionForSquare = canonicalSquareToBoardCoordinate;

export function snapshotOccupancy(snapshot: PresentationSnapshot): Map<string, PresentedPiece> {
  const occupancy = new Map<string, PresentedPiece>();
  for (const piece of snapshot.pieces) {
    assertSquare(piece.board_square);
    if (occupancy.has(piece.board_square)) {
      throw new Error(`Presentation snapshot has duplicate occupancy at ${piece.board_square}`);
    }
    occupancy.set(piece.board_square, piece);
  }
  return occupancy;
}

export function snapshotIdentityProjection(snapshot: PresentationSnapshot): Map<string, PresentedPiece> {
  const identities = new Map<string, PresentedPiece>();
  for (const piece of snapshot.pieces) {
    if (piece.piece_identity.trim().length === 0) throw new Error('Presentation piece identity must not be empty');
    if (identities.has(piece.piece_identity)) {
      throw new Error(`Presentation snapshot has duplicate piece identity: ${piece.piece_identity}`);
    }
    identities.set(piece.piece_identity, piece);
  }
  return identities;
}

export const snapshotIdentities = snapshotIdentityProjection;

export function projectSnapshot(
  snapshot: PresentationSnapshot,
  orientation: BoardOrientationInput = 'white',
  squareSize = 1,
): BoardSnapshotProjection {
  const view = normalizeBoardOrientation(orientation);
  const pieces = [...snapshot.pieces]
    .sort((a, b) => canonicalSquareToIndex(a.board_square) - canonicalSquareToIndex(b.board_square))
    .map((piece): BoardPieceProjection => ({
      ...piece,
      ...canonicalSquareToBoardCoordinate(piece.board_square, view, squareSize),
    }));
  const occupancy = new Map<string, BoardPieceProjection>();
  const identities = new Map<string, BoardPieceProjection>();
  for (const piece of pieces) {
    if (occupancy.has(piece.square)) throw new Error(`Presentation snapshot has duplicate occupancy at ${piece.square}`);
    if (identities.has(piece.piece_identity)) {
      throw new Error(`Presentation snapshot has duplicate piece identity: ${piece.piece_identity}`);
    }
    occupancy.set(piece.square, piece);
    identities.set(piece.piece_identity, piece);
  }
  return { orientation: view, squareSize, pieces, occupancy, identities };
}

export function projectSnapshotOccupancy(
  snapshot: PresentationSnapshot,
  orientation: BoardOrientationInput = 'white',
  squareSize = 1,
): Map<string, BoardPieceProjection> {
  return new Map(projectSnapshot(snapshot, orientation, squareSize).occupancy);
}

export function projectSnapshotIdentities(
  snapshot: PresentationSnapshot,
  orientation: BoardOrientationInput = 'white',
  squareSize = 1,
): Map<string, BoardPieceProjection> {
  return new Map(projectSnapshot(snapshot, orientation, squareSize).identities);
}

export function projectIdentityUpdates(
  before: PresentationSnapshot,
  after: PresentationSnapshot,
  orientation: BoardOrientationInput = 'white',
  squareSize = 1,
): PieceIdentityUpdate[] {
  const previous = projectSnapshot(before, orientation, squareSize).identities;
  const next = projectSnapshot(after, orientation, squareSize).identities;
  const identities = new Set([...previous.keys(), ...next.keys()]);
  return [...identities].sort().map((piece_identity) => ({
    piece_identity,
    before: previous.get(piece_identity) ?? null,
    after: next.get(piece_identity) ?? null,
  }));
}

export function fallbackAssetDescriptor(
  piece: Pick<PresentedPiece, 'piece_identity' | 'piece_type' | 'color' | 'visual_asset_id'>,
): FallbackAssetDescriptor {
  return {
    kind: 'primitive-fallback',
    piece_identity: piece.piece_identity,
    piece_type: piece.piece_type,
    color: piece.color,
    visual_asset_id: piece.visual_asset_id,
    label: `${piece.color} ${piece.piece_type}`,
  };
}

export const primitiveAssetDescriptor = fallbackAssetDescriptor;

type PrimitiveMaterial = 'piece' | 'detail';
type Vec3Tuple = readonly [number, number, number];
type ProfilePoint = readonly [number, number];

interface PrimitivePart {
  readonly geometry: THREE.BufferGeometry;
  readonly position: Vec3Tuple;
  readonly rotation: Vec3Tuple;
  readonly material: PrimitiveMaterial;
}

type PrimitiveGeometryCache = Record<PieceType, readonly PrimitivePart[]>;

function primitivePart(
  geometry: THREE.BufferGeometry,
  position: Vec3Tuple,
  rotation: Vec3Tuple = [0, 0, 0],
  material: PrimitiveMaterial = 'piece',
): PrimitivePart {
  return { geometry, position, rotation, material };
}

function lathePart(
  profile: readonly ProfilePoint[],
  position: Vec3Tuple = [0, 0, 0],
  material: PrimitiveMaterial = 'piece',
): PrimitivePart {
  const geometry = new THREE.LatheGeometry(
    profile.map(([radius, height]) => new THREE.Vector2(radius, height)),
    16,
  );
  geometry.computeVertexNormals();
  return primitivePart(geometry, position, [0, 0, 0], material);
}

function extrudedPart(
  shape: THREE.Shape,
  depth: number,
  position: Vec3Tuple = [0, 0, 0],
  material: PrimitiveMaterial = 'piece',
): PrimitivePart {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: 0.025,
    bevelThickness: 0.025,
    curveSegments: 2,
    depth,
    steps: 1,
  });
  // Center the extrusion on the piece's local front/back axis so a flipped
  // camera sees the same silhouette and the move pivot remains at the base.
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return primitivePart(geometry, position, [0, 0, 0], material);
}

function knightSilhouette(): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(-0.22, 0.02);
  shape.lineTo(-0.29, 0.30);
  shape.lineTo(-0.22, 0.58);
  shape.lineTo(-0.15, 0.78);
  shape.lineTo(-0.24, 1.06);
  shape.lineTo(-0.15, 1.12); // rear ear tip
  shape.lineTo(-0.05, 0.98);
  shape.lineTo(0.05, 1.03);
  shape.lineTo(0.17, 0.96);
  shape.lineTo(0.28, 0.88);
  shape.lineTo(0.32, 0.78); // muzzle
  shape.lineTo(0.24, 0.70);
  shape.lineTo(0.10, 0.71);
  shape.lineTo(0.03, 0.59);
  shape.lineTo(0.05, 0.27);
  shape.lineTo(0.15, 0.04);
  shape.closePath();
  return shape;
}

function knightSecondEar(): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(-0.09, 0.95);
  shape.lineTo(-0.025, 1.18);
  shape.lineTo(0.065, 1.03);
  shape.lineTo(0.01, 0.92);
  shape.closePath();
  return shape;
}

function createPrimitiveGeometryCache(): PrimitiveGeometryCache {
  const pawnBody: readonly ProfilePoint[] = [
    [0, 0], [0.24, 0], [0.29, 0.04], [0.34, 0.10], [0.34, 0.15],
    [0.30, 0.20], [0.24, 0.24], [0.20, 0.30], [0.19, 0.38],
    [0.16, 0.43], [0.15, 0.56], [0.19, 0.62], [0, 0.62],
  ];
  const standardBody: readonly ProfilePoint[] = [
    [0, 0], [0.26, 0], [0.31, 0.04], [0.35, 0.10], [0.34, 0.16],
    [0.29, 0.21], [0.23, 0.25], [0.22, 0.31], [0.25, 0.36],
    [0.27, 0.43], [0.25, 0.76], [0.22, 0.84], [0.30, 0.89],
    [0.30, 0.95], [0, 0.95],
  ];
  const bishopHead: readonly ProfilePoint[] = [
    [0, 0], [0.13, 0], [0.19, 0.06], [0.20, 0.14], [0.16, 0.24],
    [0.14, 0.37], [0.10, 0.50], [0.07, 0.58], [0, 0.63],
  ];
  const rookCrenels = [-1, 1].flatMap((x) => [-1, 1].map((z) => primitivePart(
    new THREE.BoxGeometry(0.15, 0.17, 0.15),
    [x * 0.19, 1.10, z * 0.19],
  )));
  const queenSpikes = Array.from({ length: 5 }, (_, index) => {
    const angle = (index / 5) * Math.PI * 2 + Math.PI / 2;
    return primitivePart(
      new THREE.ConeGeometry(0.065, 0.30, 6),
      [Math.cos(angle) * 0.19, 1.20, Math.sin(angle) * 0.19],
    );
  });
  const bishopSlits = [-1, 1].map((side) => primitivePart(
    new THREE.BoxGeometry(0.045, 0.34, 0.025),
    [0, 1.14, side * 0.17],
    [0, 0, -0.52],
    'detail',
  ));
  const knightEyeGeometry = new THREE.SphereGeometry(0.035, 8, 6);
  const knightNostrilGeometry = new THREE.SphereGeometry(0.025, 8, 6);
  const knightMouthGeometry = new THREE.BoxGeometry(0.13, 0.018, 0.018);
  return {
    pawn: [
      lathePart(pawnBody),
      primitivePart(new THREE.TorusGeometry(0.16, 0.035, 8, 16), [0, 0.60, 0], [Math.PI / 2, 0, 0]),
      primitivePart(new THREE.SphereGeometry(0.225, 16, 10), [0, 0.82, 0]),
    ],
    rook: [
      lathePart(standardBody),
      primitivePart(new THREE.CylinderGeometry(0.31, 0.31, 0.10, 16), [0, 0.99, 0]),
      ...rookCrenels,
    ],
    knight: [
      lathePart(pawnBody),
      extrudedPart(knightSilhouette(), 0.30, [0, 0.24, 0]),
      extrudedPart(knightSecondEar(), 0.24, [0, 0.24, 0]),
      ...[-1, 1].map((side) => primitivePart(knightEyeGeometry, [0.13, 1.16, side * 0.16], [0, 0, 0], 'detail')),
      ...[-1, 1].map((side) => primitivePart(knightNostrilGeometry, [0.27, 1.00, side * 0.16], [0, 0, 0], 'detail')),
      ...[-1, 1].map((side) => primitivePart(knightMouthGeometry, [0.23, 0.93, side * 0.16], [0, 0, 0.08], 'detail')),
    ],
    bishop: [
      lathePart(standardBody),
      lathePart(bishopHead, [0, 0.83, 0]),
      ...bishopSlits,
    ],
    queen: [
      lathePart(standardBody),
      primitivePart(new THREE.TorusGeometry(0.26, 0.045, 8, 16), [0, 1.00, 0], [Math.PI / 2, 0, 0]),
      primitivePart(new THREE.SphereGeometry(0.105, 12, 8), [0, 1.10, 0], [0, 0, 0], 'detail'),
      ...queenSpikes,
    ],
    king: [
      lathePart(standardBody),
      primitivePart(new THREE.BoxGeometry(0.11, 0.43, 0.11), [0, 1.17, 0], [0, 0, 0], 'detail'),
      primitivePart(new THREE.BoxGeometry(0.38, 0.11, 0.11), [0, 1.28, 0], [0, 0, 0], 'detail'),
    ],
  };
}

function colorForPiece(color: Color): number {
  return color === 'white' ? 0xf1e4ce : 0x23303b;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function documentFor(container: HTMLElement): Document | null {
  if (container.ownerDocument) return container.ownerDocument;
  return typeof document === 'undefined' ? null : document;
}

function viewportWidth(container: HTMLElement): number {
  return container.clientWidth > 0 ? container.clientWidth : 640;
}

function viewportHeight(container: HTMLElement, width: number): number {
  return container.clientHeight > 0 ? container.clientHeight : width;
}

export class Board3DRenderer {
  readonly container: HTMLElement;
  readonly options: Board3DRendererOptions;

  private rendererMode: BoardRendererStatus = 'unmounted';
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private boardRoot: THREE.Group | null = null;
  private pieceRoot: THREE.Group | null = null;
  private highlightRoot: THREE.Group | null = null;
  private squareMeshes = new Map<string, THREE.Mesh>();
  private pieceObjects = new Map<string, THREE.Group>();
  private pieceVisualKeys = new Map<string, string>();
  private primitiveGeometries: PrimitiveGeometryCache | null = null;
  private sharedMaterials: Record<string, THREE.Material> = {};
  private fallbackRoot: HTMLElement | null = null;
  private fallbackGrid: HTMLElement | null = null;
  private fallbackOrientation: BoardOrientation | null = null;
  private snapshot: PresentationSnapshot | null = null;
  private lastMove: MoveRecord | null = null;
  private rendererError: string | null = null;
  private resizeHandler: (() => void) | null = null;
  private orientationValue: BoardOrientation;
  private readonly animationModel = createReplayAnimationModel();
  private animationFrameHandle: number | null = null;
  private animationGeneration = 0;

  constructor(container: HTMLElement, options: Board3DRendererOptions = {}) {
    this.container = container;
    this.options = options;
    this.orientationValue = normalizeBoardOrientation(options.orientation ?? 'white');
  }

  get status(): BoardRendererStatus {
    return this.rendererMode;
  }

  get orientation(): BoardOrientation {
    return this.orientationValue;
  }

  get usesFallback(): boolean {
    return this.rendererMode === 'fallback' || this.rendererMode === 'unavailable';
  }

  get currentSnapshot(): PresentationSnapshot | null {
    return this.snapshot;
  }

  get currentMove(): MoveRecord | null {
    return this.lastMove;
  }

  setFlipped(flipped: boolean): void {
    this.setOrientation(flipped ? 'black' : 'white');
  }

  mount(): BoardMountResult {
    if (this.rendererMode !== 'unmounted') {
      return { status: this.rendererMode, error: this.rendererError };
    }
    if (!this.container || typeof this.container.appendChild !== 'function') {
      this.rendererMode = 'unavailable';
      this.rendererError = 'A board renderer requires a supplied HTMLElement container';
      return { status: this.rendererMode, error: this.rendererError };
    }

    try {
      const parameters = boardRendererParameters(this.options);
      this.renderer = this.options.rendererFactory
        ? this.options.rendererFactory(parameters)
        : new THREE.WebGLRenderer(parameters);
      const shadowMap = this.renderer.shadowMap;
      if (shadowMap) {
        shadowMap.enabled = true;
        shadowMap.type = THREE.PCFSoftShadowMap;
      }
      this.renderer.setPixelRatio(this.pixelRatio());
      this.renderer.setClearColor(this.options.backgroundColor ?? 0x111820, 1);
      this.container.replaceChildren(this.renderer.domElement);
      this.renderer.domElement.classList.add('board3d-canvas');
      this.renderer.domElement.setAttribute('aria-label', 'Three-dimensional chess board');
      this.createScene();
      this.resize();
      this.resizeHandler = () => this.resize();
      if (typeof window !== 'undefined') window.addEventListener('resize', this.resizeHandler);
      this.rendererMode = 'webgl';
      this.rendererError = null;
      if (this.snapshot) this.renderWebGL();
      return { status: this.rendererMode, error: null };
    } catch (error) {
      this.rendererMode = 'fallback';
      this.rendererError = errorMessage(error);
      this.renderer = null;
      this.showFallbackRoot(this.rendererError);
      return { status: this.rendererMode, error: this.rendererError };
    }
  }

  setOrientation(orientation: BoardOrientationInput): void {
    const next = normalizeBoardOrientation(orientation);
    if (next === this.orientationValue) return;
    this.orientationValue = next;
    if (this.rendererMode === 'webgl') {
      this.positionBoardSquares();
      this.positionCamera();
      if (this.snapshot) this.renderWebGL();
    } else if (this.rendererMode === 'fallback') {
      this.fallbackOrientation = null;
      if (this.snapshot) this.renderFallback(this.snapshot);
    }
  }

  flip(): void {
    this.setOrientation(this.orientationValue === 'white' ? 'black' : 'white');
  }

  /** Stop a visual transition and redraw the authoritative snapshot immediately. */
  cancelAnimation(): void {
    this.animationGeneration += 1;
    if (this.animationFrameHandle !== null) {
      if (typeof window !== 'undefined') window.cancelAnimationFrame(this.animationFrameHandle);
      this.animationFrameHandle = null;
    }
    if (this.animationModel.status !== 'running') return;
    this.animationModel.cancel();
    if (this.rendererMode === 'webgl') this.renderWebGL();
    else if (this.rendererMode === 'fallback' && this.snapshot) this.renderFallback(this.snapshot);
  }

  resize(): void {
    if (!this.renderer || !this.camera) return;
    const width = viewportWidth(this.container);
    const height = viewportHeight(this.container, width);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  render(
    snapshot: PresentationSnapshot,
    move: MoveRecord | null = null,
    animationOptions: ReplayAnimationOptions = {},
  ): BoardRenderResult {
    const previous = this.snapshot;
    this.cancelAnimation();
    this.snapshot = snapshot;
    this.lastMove = move;
    if (this.rendererMode === 'unmounted') this.mount();
    if (this.rendererMode === 'webgl') {
      try {
        const canAnimate = previous !== null && move !== null && previous.after_ply + 1 === snapshot.after_ply;
        if (canAnimate) this.startAnimation(previous, snapshot, move, animationOptions);
        else this.renderWebGL();
      } catch (error) {
        this.rendererMode = 'fallback';
        this.rendererError = errorMessage(error);
        this.renderer?.dispose();
        this.renderer = null;
        this.showFallbackRoot(this.rendererError);
        this.renderFallback(snapshot);
      }
    } else if (this.rendererMode === 'fallback') {
      this.renderFallback(snapshot);
    }
    const projection = projectSnapshot(snapshot, this.orientationValue, this.options.squareSize ?? 1);
    return {
      status: this.rendererMode === 'unmounted' ? 'unavailable' : this.rendererMode,
      squareCount: BOARD_SQUARE_COUNT,
      pieceCount: projection.pieces.length,
      fallbackAssetCount: this.usesFallback ? projection.pieces.length : 0,
      error: this.rendererError,
    };
  }

  pieceObject(pieceIdentity: string): THREE.Object3D | null {
    return this.pieceObjects.get(pieceIdentity) ?? null;
  }

  pieceObjectsSnapshot(): ReadonlyMap<string, THREE.Object3D> {
    return new Map(this.pieceObjects);
  }

  dispose(): void {
    this.cancelAnimation();
    if (this.resizeHandler && typeof window !== 'undefined') window.removeEventListener('resize', this.resizeHandler);
    this.resizeHandler = null;
    this.renderer?.dispose();
    for (const material of Object.values(this.sharedMaterials)) material.dispose();
    for (const parts of Object.values(this.primitiveGeometries ?? {})) {
      for (const part of parts) part.geometry.dispose();
    }
    this.scene = null;
    this.camera = null;
    this.boardRoot = null;
    this.pieceRoot = null;
    this.highlightRoot = null;
    this.renderer = null;
    this.squareMeshes.clear();
    this.pieceObjects.clear();
    this.pieceVisualKeys.clear();
    this.primitiveGeometries = null;
    this.sharedMaterials = {};
    this.rendererMode = 'unmounted';
    this.fallbackRoot = null;
    this.fallbackGrid = null;
    this.fallbackOrientation = null;
  }

  private pixelRatio(): number {
    if (typeof window === 'undefined' || !Number.isFinite(window.devicePixelRatio)) return 1;
    return Math.min(Math.max(window.devicePixelRatio, 1), 2);
  }

  private createScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.options.backgroundColor ?? 0x111820);
    this.camera = new THREE.PerspectiveCamera(33, 1, 0.1, 100);
    this.positionCamera();

    const ambient = new THREE.HemisphereLight(0xf4ead8, 0x17212b, 2.2);
    const key = new THREE.DirectionalLight(0xffefd3, 3.2);
    key.position.set(-4, 9, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 24;
    key.shadow.camera.left = -7;
    key.shadow.camera.right = 7;
    key.shadow.camera.top = 7;
    key.shadow.camera.bottom = -7;
    this.scene.add(ambient, key);

    this.boardRoot = new THREE.Group();
    this.boardRoot.name = 'board';
    this.pieceRoot = new THREE.Group();
    this.pieceRoot.name = 'pieces';
    this.highlightRoot = new THREE.Group();
    this.highlightRoot.name = 'last-move';
    this.scene.add(this.boardRoot, this.pieceRoot, this.highlightRoot);
    this.primitiveGeometries = createPrimitiveGeometryCache();
    this.sharedMaterials = {
      boardLight: new THREE.MeshStandardMaterial({ color: 0xd8c7a8, roughness: 0.9 }),
      boardDark: new THREE.MeshStandardMaterial({ color: 0x3f5a5a, roughness: 0.9 }),
      boardFrame: new THREE.MeshStandardMaterial({ color: 0x171d24, roughness: 0.72, metalness: 0.1 }),
      whitePiece: new THREE.MeshStandardMaterial({ color: colorForPiece('white'), roughness: 0.42, metalness: 0.05 }),
      blackPiece: new THREE.MeshStandardMaterial({ color: colorForPiece('black'), roughness: 0.44, metalness: 0.1 }),
      whiteDetail: new THREE.MeshStandardMaterial({ color: 0x8f5b43, roughness: 0.36, metalness: 0.08 }),
      blackDetail: new THREE.MeshStandardMaterial({ color: 0x9fc4bd, roughness: 0.36, metalness: 0.12 }),
      moveFrom: new THREE.MeshBasicMaterial({ color: 0xffbf52, transparent: true, opacity: 0.62 }),
      moveTo: new THREE.MeshBasicMaterial({ color: 0x65d5a6, transparent: true, opacity: 0.66 }),
    };

    const squareSize = this.options.squareSize ?? 1;
    const tileGeometry = new THREE.BoxGeometry(squareSize, 0.12, squareSize);
    const frameGeometry = new THREE.BoxGeometry(squareSize * BOARD_SIZE + 0.34, 0.2, squareSize * BOARD_SIZE + 0.34);
    const frame = new THREE.Mesh(frameGeometry, this.sharedMaterials.boardFrame);
    frame.name = 'board-frame';
    frame.position.y = -0.14;
    frame.receiveShadow = true;
    this.boardRoot.add(frame);
    for (let index = 0; index < BOARD_SQUARE_COUNT; index += 1) {
      const square = indexToCanonicalSquare(index);
      const file = index % BOARD_SIZE;
      const rank = Math.floor(index / BOARD_SIZE);
      const tile = new THREE.Mesh(tileGeometry, (file + rank) % 2 === 0
        ? this.sharedMaterials.boardLight
        : this.sharedMaterials.boardDark);
      tile.name = `square:${square}`;
      tile.userData.canonicalSquare = square;
      tile.receiveShadow = true;
      this.squareMeshes.set(square, tile);
      this.boardRoot.add(tile);
    }
    const highlightGeometry = new THREE.BoxGeometry(squareSize * 0.84, 0.025, squareSize * 0.84);
    for (const [name, material] of [['from', this.sharedMaterials.moveFrom], ['to', this.sharedMaterials.moveTo]] as const) {
      const highlight = new THREE.Mesh(highlightGeometry, material);
      highlight.name = `highlight:${name}`;
      highlight.visible = false;
      highlight.position.y = 0.075;
      this.highlightRoot.add(highlight);
    }
    this.positionBoardSquares();
  }

  private positionCamera(): void {
    if (!this.camera) return;
    const distance = (this.options.squareSize ?? 1) * 10.25;
    this.camera.position.set(0, distance * 0.86, this.orientationValue === 'white' ? distance : -distance);
    this.camera.lookAt(0, -0.08, 0);
  }

  private positionBoardSquares(): void {
    const squareSize = this.options.squareSize ?? 1;
    for (const [square, mesh] of this.squareMeshes) {
      const coordinate = canonicalSquareToBoardCoordinate(square, this.orientationValue, squareSize);
      mesh.position.set(coordinate.x, 0, coordinate.z);
    }
  }

  private startAnimation(
    before: PresentationSnapshot,
    after: PresentationSnapshot,
    move: MoveRecord,
    options: ReplayAnimationOptions = {},
  ): void {
    const plan = this.animationModel.begin(before, after, move, options);
    if (plan.mode === 'immediate' || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      this.animationModel.settle();
      this.renderWebGL();
      return;
    }

    const generation = ++this.animationGeneration;
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.applyAnimationFrame(plan.frame(0));
    const tick = (timestamp: number): void => {
      if (generation !== this.animationGeneration) return;
      const frame = plan.frameAt(Math.max(0, timestamp - startedAt));
      this.applyAnimationFrame(frame);
      if (frame.settled) {
        this.animationFrameHandle = null;
        this.animationModel.settle();
        this.renderWebGL();
        return;
      }
      this.animationFrameHandle = window.requestAnimationFrame(tick);
    };
    this.animationFrameHandle = window.requestAnimationFrame(tick);
  }

  private animationProjection(piece: AnimationPieceFrame): BoardPieceProjection {
    const square = piece.position.kind === 'square' ? piece.position.square : piece.position.to;
    if (square === undefined) throw new Error(`Animation piece ${piece.piece_identity} has no board square`);
    const target = canonicalSquareToBoardCoordinate(square, this.orientationValue, this.options.squareSize ?? 1);
    if (piece.position.kind === 'square') {
      return {
        square,
        file: target.file,
        rank: target.rank,
        x: target.x,
        z: target.z,
        piece_identity: piece.piece_identity,
        piece_type: piece.piece_type,
        color: piece.color,
        visual_asset_id: piece.visual_asset_id,
      };
    }
    if (piece.position.from === undefined || piece.position.progress === undefined) {
      throw new Error(`Animation piece ${piece.piece_identity} has an incomplete interpolation`);
    }
    const start = canonicalSquareToBoardCoordinate(piece.position.from, this.orientationValue, this.options.squareSize ?? 1);
    const progress = Math.min(1, Math.max(0, piece.position.progress));
    return {
      square,
      file: target.file,
      rank: target.rank,
      x: start.x + (target.x - start.x) * progress,
      z: start.z + (target.z - start.z) * progress,
      piece_identity: piece.piece_identity,
      piece_type: piece.piece_type,
      color: piece.color,
      visual_asset_id: piece.visual_asset_id,
    };
  }

  private applyAnimationFrame(frame: ReplayAnimationFrame): void {
    if (!this.pieceRoot || !this.primitiveGeometries) throw new Error('Three.js piece scene is not initialized');
    for (const piece of frame.pieces) {
      const projection = this.animationProjection(piece);
      let object = this.pieceObjects.get(piece.piece_identity);
      if (!object) {
        object = new THREE.Group();
        object.name = `piece:${piece.piece_identity}`;
        object.userData.piece_identity = piece.piece_identity;
        this.pieceObjects.set(piece.piece_identity, object);
        this.pieceRoot.add(object);
      }
      const visualKey = `${projection.color}:${projection.piece_type}:${projection.visual_asset_id}`;
      if (this.pieceVisualKeys.get(piece.piece_identity) !== visualKey) {
        object.clear();
        const custom = this.options.pieceAssetFactory?.({
          piece_identity: projection.piece_identity,
          piece_type: projection.piece_type,
          color: projection.color,
          board_square: projection.square,
          visual_asset_id: projection.visual_asset_id,
        });
        const visual = custom ?? this.createPrimitivePieceVisual(projection);
        visual.userData.piece_identity = projection.piece_identity;
        visual.userData.assetMode = custom ? 'provided' : 'primitive-fallback';
        object.add(visual);
        this.pieceVisualKeys.set(piece.piece_identity, visualKey);
      }
      const liftProgress = piece.position.kind === 'interpolated' ? piece.position.progress : 0;
      if (liftProgress === undefined) throw new Error(`Animation piece ${piece.piece_identity} has no interpolation progress`);
      const lift = piece.position.kind === 'interpolated' ? Math.sin(liftProgress * Math.PI) * 0.28 : 0;
      object.position.set(projection.x, 0.08 + lift, projection.z);
      object.visible = piece.visible;
      object.userData.board_square = projection.square;
      object.userData.piece_type = projection.piece_type;
      object.userData.color = projection.color;
    }
    this.updateHighlights(this.lastMove);
    if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
  }

  private renderWebGL(): void {
    if (!this.renderer || !this.scene || !this.camera || !this.pieceRoot || !this.highlightRoot) {
      throw new Error('Three.js board scene is not initialized');
    }
    const projection = projectSnapshot(this.snapshot!, this.orientationValue, this.options.squareSize ?? 1);
    this.updateThreePieces(projection);
    this.updateHighlights(this.lastMove);
    this.renderer.render(this.scene, this.camera);
  }

  private updateThreePieces(projection: BoardSnapshotProjection): void {
    if (!this.pieceRoot || !this.primitiveGeometries) throw new Error('Three.js piece scene is not initialized');
    const active = new Set<string>();
    for (const piece of projection.pieces) {
      active.add(piece.piece_identity);
      let object = this.pieceObjects.get(piece.piece_identity);
      if (!object) {
        object = new THREE.Group();
        object.name = `piece:${piece.piece_identity}`;
        object.userData.piece_identity = piece.piece_identity;
        this.pieceObjects.set(piece.piece_identity, object);
        this.pieceRoot.add(object);
      }
      const visualKey = `${piece.color}:${piece.piece_type}:${piece.visual_asset_id}`;
      if (this.pieceVisualKeys.get(piece.piece_identity) !== visualKey) {
        object.clear();
        const custom = this.options.pieceAssetFactory?.({
          piece_identity: piece.piece_identity,
          piece_type: piece.piece_type,
          color: piece.color,
          board_square: piece.square,
          visual_asset_id: piece.visual_asset_id,
        });
        const visual = custom ?? this.createPrimitivePieceVisual(piece);
        visual.userData.piece_identity = piece.piece_identity;
        visual.userData.assetMode = custom ? 'provided' : 'primitive-fallback';
        object.add(visual);
        this.pieceVisualKeys.set(piece.piece_identity, visualKey);
      }
      object.position.set(piece.x, 0.08, piece.z);
      object.userData.board_square = piece.square;
      object.userData.piece_type = piece.piece_type;
      object.userData.color = piece.color;
    }
    for (const [identity, object] of this.pieceObjects) {
      if (active.has(identity)) continue;
      object.removeFromParent();
      this.pieceObjects.delete(identity);
      this.pieceVisualKeys.delete(identity);
    }
  }

  private createPrimitivePieceVisual(piece: BoardPieceProjection): THREE.Group {
    const group = new THREE.Group();
    group.name = `staunton:${piece.color}-${piece.piece_type}`;
    group.userData.fallbackAsset = fallbackAssetDescriptor(piece);
    const pieceMaterial = piece.color === 'white' ? 'whitePiece' : 'blackPiece';
    const detailMaterial = piece.color === 'white' ? 'whiteDetail' : 'blackDetail';
    for (const part of this.primitiveGeometries![piece.piece_type]) {
      const material = this.sharedMaterials[part.material === 'detail' ? detailMaterial : pieceMaterial];
      const mesh = new THREE.Mesh(part.geometry, material);
      mesh.position.set(...part.position);
      mesh.rotation.set(...part.rotation);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }

  private updateHighlights(move: MoveRecord | null): void {
    if (!this.highlightRoot) return;
    const from = this.highlightRoot.getObjectByName('highlight:from');
    const to = this.highlightRoot.getObjectByName('highlight:to');
    if (!(from instanceof THREE.Mesh) || !(to instanceof THREE.Mesh)) return;
    if (!move) {
      from.visible = false;
      to.visible = false;
      return;
    }
    const squareSize = this.options.squareSize ?? 1;
    const fromPosition = canonicalSquareToBoardCoordinate(move.from, this.orientationValue, squareSize);
    const toPosition = canonicalSquareToBoardCoordinate(move.to, this.orientationValue, squareSize);
    from.position.set(fromPosition.x, 0.075, fromPosition.z);
    to.position.set(toPosition.x, 0.075, toPosition.z);
    from.visible = true;
    to.visible = true;
  }

  private showFallbackRoot(reason: string): void {
    const doc = documentFor(this.container);
    if (!doc) {
      this.container.textContent = `3D board unavailable: ${reason}`;
      return;
    }
    this.container.replaceChildren();
    const root = doc.createElement('section');
    root.className = 'board3d-debug-fallback';
    root.dataset.rendererStatus = 'fallback';
    root.setAttribute('aria-label', 'Chess board fallback');
    root.style.display = 'grid';
    root.style.gap = '0.5rem';
    root.style.width = '100%';
    root.style.maxWidth = '720px';
    const message = doc.createElement('p');
    message.className = 'board3d-debug-message';
    message.textContent = `3D board fallback: ${reason}`;
    message.style.margin = '0';
    message.style.font = '0.75rem ui-monospace, monospace';
    message.style.color = '#f0d29b';
    root.append(message);
    const grid = doc.createElement('div');
    grid.className = 'board3d-debug-grid';
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', 'Deterministic chess board fallback');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(8, minmax(0, 1fr))';
    grid.style.aspectRatio = '1';
    grid.style.border = '1px solid #8e806a';
    root.append(grid);
    this.container.append(root);
    this.fallbackRoot = root;
    this.fallbackGrid = grid;
    this.fallbackOrientation = null;
  }

  private renderFallback(snapshot: PresentationSnapshot): void {
    if (!this.fallbackRoot || !this.fallbackGrid || this.fallbackOrientation !== this.orientationValue) {
      this.showFallbackRoot(this.rendererError ?? 'WebGL is not available');
    }
    if (!this.fallbackGrid) return;
    const projection = projectSnapshot(snapshot, this.orientationValue, this.options.squareSize ?? 1);
    const occupancy = projection.occupancy;
    const squares = canonicalBoardSquares(this.orientationValue);
    this.fallbackGrid.replaceChildren();
    const doc = documentFor(this.container);
    if (!doc) return;
    for (const square of squares) {
      const cell = doc.createElement('div');
      const index = canonicalSquareToIndex(square);
      const file = index % BOARD_SIZE;
      const rank = Math.floor(index / BOARD_SIZE);
      const piece = occupancy.get(square);
      cell.className = 'board3d-debug-square';
      cell.dataset.square = square;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', piece ? `${square}: ${piece.color} ${piece.piece_type}` : `${square}: empty`);
      cell.title = piece ? `${square} · ${piece.color} ${piece.piece_type} · ${piece.piece_identity}` : `${square} · empty`;
      cell.textContent = piece ? `${piece.color} ${piece.piece_type}` : square;
      cell.style.display = 'grid';
      cell.style.placeItems = 'center';
      cell.style.minWidth = '0';
      cell.style.aspectRatio = '1';
      cell.style.padding = '0.2rem';
      cell.style.textAlign = 'center';
      cell.style.font = 'clamp(0.42rem, 1.3vw, 0.75rem) ui-monospace, monospace';
      cell.style.overflow = 'hidden';
      cell.style.background = (file + rank) % 2 === 0 ? '#d8c7a8' : '#3f5a5a';
      cell.style.color = piece?.color === 'white' ? '#242a31' : piece?.color === 'black' ? '#f5ead8' : '#6b655a';
      this.fallbackGrid.append(cell);
    }
    this.fallbackOrientation = this.orientationValue;
  }
}

export function createBoard3DRenderer(
  container: HTMLElement,
  options: Board3DRendererOptions = {},
): Board3DRenderer {
  const renderer = new Board3DRenderer(container, options);
  renderer.mount();
  return renderer;
}

export const createBoardRenderer = createBoard3DRenderer;
