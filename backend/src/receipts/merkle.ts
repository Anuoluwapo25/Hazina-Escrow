/**
 * merkle.ts — Merkle tree construction and inclusion proofs for receipt batching.
 */

import { createHash } from 'crypto';

export interface MerkleTree {
  root: string;
  leaves: string[];
  levels: string[][];
}

export interface InclusionProof {
  leafIndex: number;
  leafHash: string;
  siblings: (string | null)[];
  root: string;
}

/**
 * Compute SHA-256 hash of concatenated buffers.
 */
function hashPair(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(Buffer.concat([left, right])).digest();
}

/**
 * Build a Merkle tree from an array of leaf hashes (hex strings).
 * Returns the tree with all levels for proof generation.
 */
export function buildMerkleTree(leaves: string[]): MerkleTree {
  if (leaves.length === 0) {
    throw new Error('Cannot build Merkle tree with zero leaves');
  }

  // Convert hex strings to Buffers
  const leafBuffers: Buffer[] = leaves.map(leaf => Buffer.from(leaf, 'hex'));

  // Validate all leaves are 32 bytes
  for (const leaf of leafBuffers) {
    if (leaf.length !== 32) {
      throw new Error(`Invalid leaf hash length: ${leaf.length}, expected 32`);
    }
  }

  const levels: Buffer[][] = [leafBuffers];

  // Build tree bottom-up
  let currentLevel = leafBuffers;
  while (currentLevel.length > 1) {
    const nextLevel: Buffer[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        // Pair exists - hash both
        nextLevel.push(hashPair(currentLevel[i]!, currentLevel[i + 1]!));
      } else {
        // Odd leaf - promote unchanged (no duplication)
        nextLevel.push(currentLevel[i]!);
      }
    }
    levels.push(nextLevel);
    currentLevel = nextLevel;
  }

  // Convert back to hex strings for output
  const hexLevels: string[][] = levels.map(level => level.map(buf => buf.toString('hex')));

  const root = hexLevels[hexLevels.length - 1]![0]!;
  const leavesOut = hexLevels[0]!;
  const levelsOut = hexLevels;

  return {
    root,
    leaves: leavesOut,
    levels: levelsOut,
  };
}

/**
 * Generate an inclusion proof for a leaf at the given index.
 * Returns the sibling hashes needed to verify the leaf against the root.
 * null in siblings indicates the node was promoted (no sibling at that level).
 */
export function generateInclusionProof(tree: MerkleTree, leafIndex: number): InclusionProof {
  if (leafIndex < 0 || leafIndex >= tree.leaves.length) {
    throw new Error(`Leaf index ${leafIndex} out of bounds (0-${tree.leaves.length - 1})`);
  }

  const siblings: (string | null)[] = [];
  let currentIndex = leafIndex;

  // Traverse up the tree collecting siblings
  for (let level = 0; level < tree.levels.length - 1; level++) {
    const levelNodes = tree.levels[level]!;
    const isRightNode = currentIndex % 2 === 1;
    const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

    if (siblingIndex < levelNodes.length) {
      // Safe because we checked bounds
      siblings.push(levelNodes[siblingIndex]!);
    } else {
      // No sibling - this node was promoted (odd count at this level)
      siblings.push(null);
    }

    currentIndex = Math.floor(currentIndex / 2);
  }

  return {
    leafIndex,
    leafHash: tree.leaves[leafIndex]!,
    siblings,
    root: tree.root,
  };
}

/**
 * Verify an inclusion proof using the simple iterative approach.
 * This is the main exported verification function.
 * null siblings indicate the node was promoted at that level (carried up unchanged).
 */
export function verifyProof(proof: InclusionProof): boolean {
  let currentHash: Buffer = Buffer.from(proof.leafHash, 'hex');
  let currentIndex = proof.leafIndex;

  for (const siblingHex of proof.siblings) {
    if (siblingHex === null) {
      // Promoted - carry hash up unchanged
    } else {
      const sibling = Buffer.from(siblingHex, 'hex');
      const isRightNode = currentIndex % 2 === 1;

      if (isRightNode) {
        currentHash = hashPair(sibling, currentHash);
      } else {
        currentHash = hashPair(currentHash, sibling);
      }
    }

    currentIndex = Math.floor(currentIndex / 2);
  }

  return currentHash.toString('hex') === proof.root;
}

/**
 * Generate proofs for all leaves in a tree (for batch anchoring).
 */
export function generateAllProofs(tree: MerkleTree): InclusionProof[] {
  return tree.leaves.map((_, index) => generateInclusionProof(tree, index));
}

/**
 * Compute the Merkle root directly from leaves (convenience function).
 */
export function computeMerkleRoot(leaves: string[]): string {
  return buildMerkleTree(leaves).root;
}