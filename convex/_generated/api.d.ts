/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as auth from "../auth.js";
import type * as authNode from "../authNode.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as events from "../events.js";
import type * as fileImport from "../fileImport.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as lib_sha256 from "../lib/sha256.js";
import type * as lib_util from "../lib/util.js";
import type * as oauth from "../oauth.js";
import type * as pages from "../pages.js";
import type * as presence from "../presence.js";
import type * as testing from "../testing.js";
import type * as webhooks from "../webhooks.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  auth: typeof auth;
  authNode: typeof authNode;
  comments: typeof comments;
  crons: typeof crons;
  events: typeof events;
  fileImport: typeof fileImport;
  files: typeof files;
  http: typeof http;
  "lib/sha256": typeof lib_sha256;
  "lib/util": typeof lib_util;
  oauth: typeof oauth;
  pages: typeof pages;
  presence: typeof presence;
  testing: typeof testing;
  webhooks: typeof webhooks;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
