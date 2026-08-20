import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { buildMerkleTree, generateInclusionProof, verifyProof, computeMerkleRoot, generateAllProofs } from './merkle';

function createLeaf(value: number): string {
  return Buffer.alloc(32, value).toString('hex');
}

describe('merkle.ts', () => {
  describe('buildMerkleTree', () => {
    it('builds tree with 1 leaf', () => {
      const leaves = [createLeaf(0xaa)];
      const tree = buildMerkleTree(leaves);
      expect(tree.root).toBe(leaves[0]!);
      expect(tree.leaves).toEqual(leaves);
      expect(tree.levels.length).toBe(1);
    });

    it('builds tree with 2 leaves', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb)];
      const tree = buildMerkleTree(leaves);
      expect(tree.root).not.toBe(leaves[0]!);
      expect(tree.root).not.toBe(leaves[1]!);
      expect(tree.levels.length).toBe(2);
      expect(tree.levels[0]).toEqual(leaves);
      expect(tree.levels[1]!.length).toBe(1);
    });

    it('builds tree with 3 leaves', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb), createLeaf(0xcc)];
      const tree = buildMerkleTree(leaves);
      expect(tree.levels.length).toBe(3); // 3 -> 2 -> 1
      expect(tree.levels[0]).toEqual(leaves);
      expect(tree.levels[1]!.length).toBe(2); // pair + promoted
      expect(tree.levels[2]!.length).toBe(1);
    });

    it('builds tree with 4 leaves', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb), createLeaf(0xcc), createLeaf(0xdd)];
      const tree = buildMerkleTree(leaves);
      expect(tree.levels.length).toBe(3); // 4 -> 2 -> 1
      expect(tree.levels[1]!.length).toBe(2);
    });

    it('builds tree with 7 leaves', () => {
      const leaves = Array.from({ length: 7 }, (_, i) => createLeaf(i));
      const tree = buildMerkleTree(leaves);
      // 7 -> 4 (3 pairs + 1 promoted) -> 2 -> 1
      expect(tree.levels.length).toBe(4);
      expect(tree.levels[0]!.length).toBe(7);
      expect(tree.levels[1]!.length).toBe(4);
      expect(tree.levels[2]!.length).toBe(2);
      expect(tree.levels[3]!.length).toBe(1);
    });

    it('builds tree with 8 leaves', () => {
      const leaves = Array.from({ length: 8 }, (_, i) => createLeaf(i));
      const tree = buildMerkleTree(leaves);
      // 8 -> 4 -> 2 -> 1
      expect(tree.levels.length).toBe(4);
      expect(tree.levels[1]!.length).toBe(4);
      expect(tree.levels[2]!.length).toBe(2);
      expect(tree.levels[3]!.length).toBe(1);
    });

    it('throws on empty leaves', () => {
      expect(() => buildMerkleTree([])).toThrow('Cannot build Merkle tree with zero leaves');
    });

    it('throws on invalid leaf length', () => {
      expect(() => buildMerkleTree(['invalid'])).toThrow('Invalid leaf hash length');
    });

    it('produces deterministic root for same leaves', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb), createLeaf(0xcc)];
      const tree1 = buildMerkleTree(leaves);
      const tree2 = buildMerkleTree(leaves);
      expect(tree1.root).toBe(tree2.root);
    });
  });

  describe('generateInclusionProof', () => {
    it('generates proof for leaf 0 in 2-leaf tree', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb)];
      const tree = buildMerkleTree(leaves);
      const proof = generateInclusionProof(tree, 0);
      expect(proof.leafIndex).toBe(0);
      expect(proof.leafHash).toBe(leaves[0]);
      expect(proof.siblings).toEqual([leaves[1]]);
      expect(proof.root).toBe(tree.root);
    });

    it('generates proof for leaf 1 in 2-leaf tree', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb)];
      const tree = buildMerkleTree(leaves);
      const proof = generateInclusionProof(tree, 1);
      expect(proof.leafIndex).toBe(1);
      expect(proof.leafHash).toBe(leaves[1]);
      expect(proof.siblings).toEqual([leaves[0]]);
      expect(proof.root).toBe(tree.root);
    });

    it('generates proof for leaf 0 in 3-leaf tree', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb), createLeaf(0xcc)];
      const tree = buildMerkleTree(leaves);
      const proof = generateInclusionProof(tree, 0);
      // Level 0: sibling is leaf 1
      // Level 1: sibling is leaf 2 (promoted)
      expect(proof.siblings.length).toBe(2);
      expect(proof.siblings[0]).toBe(leaves[1]);
      expect(proof.siblings[1]).toBe(leaves[2]);
    });

    it('generates proof for leaf 2 in 3-leaf tree (promoted leaf)', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb), createLeaf(0xcc)];
      const tree = buildMerkleTree(leaves);
      const proof = generateInclusionProof(tree, 2);
      // Level 0: no sibling (promoted) -> null
      // Level 1: sibling is hash of leaf 0 + leaf 1
      expect(proof.siblings.length).toBe(2);
      expect(proof.siblings[0]).toBeNull();
      expect(proof.siblings[1]).toBe(tree.levels[1]![0]); // hash of leaf 0 + leaf 1
    });

    it('throws on out of bounds index', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb)];
      const tree = buildMerkleTree(leaves);
      expect(() => generateInclusionProof(tree, -1)).toThrow('out of bounds');
      expect(() => generateInclusionProof(tree, 2)).toThrow('out of bounds');
    });
  });

  describe('verifyProof', () => {
    it('verifies valid proof for 1-leaf tree', () => {
      const leaves = [createLeaf(0xaa)];
      const tree = buildMerkleTree(leaves);
      const proof = generateInclusionProof(tree, 0);
      expect(verifyProof(proof)).toBe(true);
    });

    it('verifies valid proof for 2-leaf tree', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb)];
      const tree = buildMerkleTree(leaves);
      expect(verifyProof(generateInclusionProof(tree, 0))).toBe(true);
      expect(verifyProof(generateInclusionProof(tree, 1))).toBe(true);
    });

    it('verifies all leaves in 3-leaf tree', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb), createLeaf(0xcc)];
      const tree = buildMerkleTree(leaves);
      expect(verifyProof(generateInclusionProof(tree, 0))).toBe(true);
      expect(verifyProof(generateInclusionProof(tree, 1))).toBe(true);
      expect(verifyProof(generateInclusionProof(tree, 2))).toBe(true);
    });

    it('verifies all leaves in 7-leaf tree', () => {
      const leaves = Array.from({ length: 7 }, (_, i) => createLeaf(i));
      const tree = buildMerkleTree(leaves);
      for (let i = 0; i < 7; i++) {
        expect(verifyProof(generateInclusionProof(tree, i))).toBe(true);
      }
    });

    it('verifies all leaves in 8-leaf tree', () => {
      const leaves = Array.from({ length: 8 }, (_, i) => createLeaf(i));
      const tree = buildMerkleTree(leaves);
      for (let i = 0; i < 8; i++) {
        expect(verifyProof(generateInclusionProof(tree, i))).toBe(true);
      }
    });

    it('rejects proof with wrong sibling', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb)];
      const tree = buildMerkleTree(leaves);
      const proof = generateInclusionProof(tree, 0);
      // Tamper with sibling
      proof.siblings[0] = createLeaf(0xcc);
      expect(verifyProof(proof)).toBe(false);
    });

    it('rejects proof with wrong root', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb)];
      const tree = buildMerkleTree(leaves);
      const proof = generateInclusionProof(tree, 0);
      proof.root = createLeaf(0xdd);
      expect(verifyProof(proof)).toBe(false);
    });

    it('rejects proof with wrong leaf hash', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb)];
      const tree = buildMerkleTree(leaves);
      const proof = generateInclusionProof(tree, 0);
      proof.leafHash = createLeaf(0xcc);
      expect(verifyProof(proof)).toBe(false);
    });
  });

  describe('computeMerkleRoot', () => {
    it('returns leaf for single leaf', () => {
      expect(computeMerkleRoot([createLeaf(0xaa)])).toBe(createLeaf(0xaa));
    });

    it('computes correct root for 2 leaves', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb)];
      const root = computeMerkleRoot(leaves);
      const expected = createHash('sha256').update(Buffer.concat([Buffer.from(leaves[0]!, 'hex'), Buffer.from(leaves[1]!, 'hex')])).digest('hex');
      expect(root).toBe(expected);
    });

    it('matches buildMerkleTree root', () => {
      const leaves = Array.from({ length: 5 }, (_, i) => createLeaf(i));
      expect(computeMerkleRoot(leaves)).toBe(buildMerkleTree(leaves).root);
    });
  });

  describe('generateAllProofs', () => {
    it('generates proofs for all leaves', () => {
      const leaves = [createLeaf(0xaa), createLeaf(0xbb), createLeaf(0xcc)];
      const tree = buildMerkleTree(leaves);
      const proofs = generateAllProofs(tree);
      expect(proofs.length).toBe(3);
      expect(proofs[0]!.leafIndex).toBe(0);
      expect(proofs[1]!.leafIndex).toBe(1);
      expect(proofs[2]!.leafIndex).toBe(2);
    });

    it('all generated proofs verify', () => {
      const leaves = Array.from({ length: 8 }, (_, i) => createLeaf(i));
      const tree = buildMerkleTree(leaves);
      const proofs = generateAllProofs(tree);
      for (const proof of proofs) {
        expect(verifyProof(proof)).toBe(true);
      }
    });
  });

  describe('edge cases for required leaf counts (1, 2, 3, 7, 8)', () => {
    const testCases = [1, 2, 3, 7, 8];

    for (const count of testCases) {
      it(`verifies every leaf in ${count}-leaf tree`, () => {
        const leaves = Array.from({ length: count }, (_, i) => createLeaf(i));
        const tree = buildMerkleTree(leaves);
        for (let i = 0; i < count; i++) {
          const proof = generateInclusionProof(tree, i);
          expect(verifyProof(proof), `Leaf ${i} in ${count}-leaf tree should verify`).toBe(true);
        }
      });
    }
  });
});