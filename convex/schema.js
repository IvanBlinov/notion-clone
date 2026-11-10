import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  users: defineTable({
    email: v.string(),
    name: v.string(),
    color: v.string(),
    passwordHash: v.string(),
    salt: v.string(),
    createdAt: v.number(),
    failedLogins: v.optional(v.number()),
    lockedUntil: v.optional(v.number()),
  }).index('by_email', ['email']),

  sessions: defineTable({ userId: v.id('users'), tokenHash: v.string(), expiresAt: v.number() })
    .index('by_tokenHash', ['tokenHash'])
    .index('by_expiresAt', ['expiresAt']),

  workspaces: defineTable({
    name: v.string(),
    ownerId: v.union(v.id('users'), v.null()),
    createdAt: v.number(),
    lastAgentAt: v.optional(v.number()),
    lastAgentTool: v.optional(v.string()),
  }),

  members: defineTable({ workspaceId: v.id('workspaces'), userId: v.id('users'), role: v.string(), joinedAt: v.number() })
    .index('by_workspace', ['workspaceId'])
    .index('by_user', ['userId'])
    .index('by_workspace_user', ['workspaceId', 'userId']),

  // workspaceId null = a platform invite: create an account (with its own workspace), join nothing
  invites: defineTable({
    workspaceId: v.union(v.id('workspaces'), v.null()),
    token: v.string(),
    email: v.union(v.string(), v.null()),
    createdBy: v.id('users'),
    createdAt: v.number(),
    expiresAt: v.number(),
    acceptedBy: v.union(v.id('users'), v.null()),
  })
    .index('by_token', ['token'])
    .index('by_workspace', ['workspaceId']),

  agentTokens: defineTable({
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    name: v.string(),
    tokenHash: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.union(v.number(), v.null()),
  })
    .index('by_tokenHash', ['tokenHash'])
    .index('by_workspace_user', ['workspaceId', 'userId']),

  // OAuth 2.1 for MCP clients that can't send a fixed header (ChatGPT, claude.ai connectors).
  // Clients register themselves (RFC 7591); an approved code is exchanged for an agent token.
  oauthClients: defineTable({
    clientId: v.string(),
    name: v.string(),
    redirectUris: v.array(v.string()),
    createdAt: v.number(),
  }).index('by_clientId', ['clientId']),

  oauthCodes: defineTable({
    codeHash: v.string(),
    clientId: v.string(),
    userId: v.id('users'),
    workspaceId: v.id('workspaces'),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    scope: v.string(),
    expiresAt: v.number(),
  }).index('by_codeHash', ['codeHash']),

  // One row per page. `pid` is the page's stable id used in URLs, parentId and page blocks.
  pages: defineTable({
    workspaceId: v.id('workspaces'),
    pid: v.string(),
    title: v.string(),
    icon: v.string(),
    parentId: v.union(v.string(), v.null()),
    position: v.number(),
    blocks: v.array(v.any()),
    favorite: v.boolean(),
    archivedAt: v.union(v.string(), v.null()),
    createdAt: v.string(),
    updatedAt: v.string(),
    createdBy: v.optional(v.string()),
    lastEditedBy: v.optional(v.string()),
    version: v.number(),
    // set on database pages: { titleName, properties, views, idem }
    database: v.optional(v.any()),
    // set on database rows: { [propertyId]: value }
    props: v.optional(v.any()),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_pid', ['workspaceId', 'pid']),

  // Comments on pages and database items (pageId = the page's pid). parentId = the thread's first comment.
  comments: defineTable({
    workspaceId: v.id('workspaces'),
    pageId: v.string(),
    parentId: v.union(v.id('comments'), v.null()),
    authorId: v.union(v.string(), v.null()), // user id, or "agent_<token id>" for an AI agent
    authorName: v.string(),
    authorKind: v.string(), // 'user' | 'agent'
    text: v.string(),
    mentions: v.array(v.string()),
    resolved: v.boolean(),
    resolvedBy: v.optional(v.string()),
    createdAt: v.number(),
    editedAt: v.optional(v.number()),
  })
    .index('by_page', ['workspaceId', 'pageId'])
    .index('by_workspace', ['workspaceId', 'createdAt']),

  // Outgoing webhooks: POST a signed JSON event list to `url` after changes.
  webhooks: defineTable({
    workspaceId: v.id('workspaces'),
    url: v.string(),
    events: v.array(v.string()),
    databaseId: v.union(v.string(), v.null()),
    secret: v.string(),
    description: v.string(),
    createdBy: v.string(),
    createdAt: v.number(),
    lastStatus: v.union(v.number(), v.null()),
    lastError: v.union(v.string(), v.null()),
    lastAt: v.union(v.number(), v.null()),
    failures: v.number(),
  }).index('by_workspace', ['workspaceId']),

  // Change feed: every saved change appends its events (page / item / database / comment) with a
  // per-workspace sequence number, so agents can read "everything after cursor N" and wait for more.
  events: defineTable({
    workspaceId: v.id('workspaces'),
    seq: v.number(),
    at: v.number(),
    events: v.any(),
  })
    .index('by_seq', ['workspaceId', 'seq'])
    .index('by_at', ['at']),
  eventSeq: defineTable({ workspaceId: v.id('workspaces'), seq: v.number() }).index('by_workspace', ['workspaceId']),

  // Files stored in Convex storage (uploads and imports), with a generated thumbnail for images.
  files: defineTable({
    workspaceId: v.id('workspaces'),
    storageId: v.id('_storage'),
    thumbId: v.union(v.id('_storage'), v.null()),
    sha256: v.string(),
    key: v.union(v.string(), v.null()),
    name: v.string(),
    size: v.number(),
    contentType: v.union(v.string(), v.null()),
    width: v.union(v.number(), v.null()),
    height: v.union(v.number(), v.null()),
    sourceUrl: v.union(v.string(), v.null()),
    createdAt: v.number(),
  })
    .index('by_hash', ['workspaceId', 'sha256'])
    .index('by_key', ['workspaceId', 'key'])
    .index('by_storage', ['storageId'])
    .index('by_workspace', ['workspaceId']),

  presence: defineTable({
    workspaceId: v.id('workspaces'),
    clientId: v.string(),
    userId: v.id('users'),
    name: v.string(),
    color: v.string(),
    pageId: v.union(v.string(), v.null()),
    lastSeen: v.number(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_client', ['clientId'])
    .index('by_lastSeen', ['lastSeen']),
});
