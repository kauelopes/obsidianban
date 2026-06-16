import { describe, it, expect } from 'vitest'
import { isToolVisible } from '../../src/server/tool-access.js'
import { makeManagerClaims, makeAgentClaims, makeDevClaims } from '../helpers/factories.js'

describe('isToolVisible', () => {
  describe('manager role', () => {
    it("can see an 'all' tool", () => {
      expect(isToolVisible('all', makeManagerClaims())).toBe(true)
    })

    it("can see a 'pm' tool", () => {
      expect(isToolVisible('pm', makeManagerClaims())).toBe(true)
    })

    it("can see a 'manager' tool", () => {
      expect(isToolVisible('manager', makeManagerClaims())).toBe(true)
    })
  })

  describe('pm agent', () => {
    it("can see an 'all' tool", () => {
      expect(isToolVisible('all', makeAgentClaims())).toBe(true)
    })

    it("can see a 'pm' tool", () => {
      expect(isToolVisible('pm', makeAgentClaims())).toBe(true)
    })

    it("cannot see a 'manager' tool", () => {
      expect(isToolVisible('manager', makeAgentClaims())).toBe(false)
    })
  })

  describe('dev agent', () => {
    it("can see an 'all' tool", () => {
      expect(isToolVisible('all', makeDevClaims())).toBe(true)
    })

    it("cannot see a 'pm' tool", () => {
      expect(isToolVisible('pm', makeDevClaims())).toBe(false)
    })

    it("cannot see a 'manager' tool", () => {
      expect(isToolVisible('manager', makeDevClaims())).toBe(false)
    })
  })
})
