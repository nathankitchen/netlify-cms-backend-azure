import { Base64 } from 'js-base64';
import { uniq, initial, last, get, first, find, flow, some, partial, result, trim } from 'lodash';
import {
  localForage,
  APIError,
  ApiRequest,
  unsentRequest,
  responseParser,
  Entry,
  AssetProxy,
  PersistOptions,
  readFile,
  CMS_BRANCH_PREFIX,
  generateContentKey,
  parseContentKey,
  labelToStatus,
  isCMSLabel,
  EditorialWorkflowError
} from 'netlify-cms-lib-util';
export const API_NAME = 'Azure DevOps';

export class AzureRepo {
  org: string;
  project: string;
  name: string;

  constructor(location?: string | null)
  {
    if (!location || location == undefined) {
      throw new Error("An Azure repository must be specified in the format 'organisation/project/repo'.");
    }

    var components = trim(location, '/').split('/', 3);
    this.org = components[0];
    this.project = components[1];
    this.name = components[2] || components[1];
  }
}

export interface AzureUser {
  id: string;
  displayName: string;
  emailAddress: string;
}

export interface AzureCommitAuthor {
  name: string;
  email: string;
}

enum AzureCommitChangeType {
  ADD = 'add',
  DELETE = 'delete',
  RENAME = 'rename',
  EDIT = 'edit',
}

enum AzureCommitContentType {
  RAW = 'rawtext',
  BASE64 = 'base64encoded'
}

class AzureCommit {
  comment: string;
  changes: AzureChangeList;

  constructor(comment: string = 'Default commit comment')
  {
    this.comment = comment;
    this.changes = new AzureChangeList();
  }
};

/**
 * Change list provides an easy way to create a range of different changes on a single
 * commit. Rename serves as move.
 */
class AzureChangeList extends Array<AzureCommitChange> {
  
  constructor() {
    super();
  }

  addBase64(path: string, base64data: string) {
    this.push(new AzureCommitAddChange(path, base64data, AzureCommitContentType.BASE64));
  }

  addRawText(path: string, text: string) {
    this.push(new AzureCommitAddChange(path, text, AzureCommitContentType.RAW));
  }

  delete(path: string) {
    this.push(new AzureCommitChange(AzureCommitChangeType.DELETE, path));
  }

  editBase64(path: string, base64data: string) {
    this.push(new AzureCommitEditChange(path, base64data, AzureCommitContentType.BASE64));
  }

  rename(source: string, destination: string) {
    this.push(new AzureCommitRenameChange(source, destination));
  }
};

type AzureRefUpdate = {
  name: string;
  oldObjectId: string;
};

type AzureRef = {
  name: string;
  objectId: string;
};


class AzureCommitChange {
  changeType: AzureCommitChangeType;
  item: AzureCommitChangeItem;

  constructor(changeType: AzureCommitChangeType, path: string) {
    this.changeType = changeType;
    this.item = new AzureCommitChangeItem(path);
  }
};

class AzureCommitAddChange extends AzureCommitChange {
  newContent: AzureChangeContent;

  constructor(path: string, content: string, type: AzureCommitContentType) {
    super(AzureCommitChangeType.ADD, path);
    this.newContent = new AzureChangeContent(content, type);
  }
};

class AzureCommitEditChange extends AzureCommitChange {
  newContent: AzureChangeContent;

  constructor(path: string, content: string, type: AzureCommitContentType) {
    super(AzureCommitChangeType.EDIT, path);
    this.newContent = new AzureChangeContent(content, type);
  }
};

class AzureCommitRenameChange extends AzureCommitChange {
  sourceServerItem: string;

  constructor(source: string, destination: string) {
    super(AzureCommitChangeType.RENAME, destination);
    this.sourceServerItem = source;
  }
};

class AzureCommitChangeItem {
  path: string;

  constructor(path: string) {
    this.path = path;
  }
};

class AzureChangeContent {
  content: string;
  contentType: AzureCommitContentType;

  constructor(content: string, type: AzureCommitContentType)
  {
    this.content = content;
    this.contentType = type;
  }
};

class AzurePush {
  refUpdates: AzureRefUpdate[];
  commits: AzureCommit[];

  constructor(ref: AzureRef) {
    this.refUpdates = [ { name: ref.name, oldObjectId: ref.objectId } ];
    this.commits = [];
  }
}

export interface AzureApiConfig {
  apiRoot: string;
  repo: AzureRepo;
  branch: string;
  path: string;
  squashMerges: boolean;
  initialWorkflowStatus: string;
}

export default class API {

  apiRoot: string;
  apiVersion: string;
  token?: string;
  branch: string;
  squashMerges: boolean;
  repo?: AzureRepo;
  endpointUrl: string;
  initialWorkflowStatus: string;
  commitAuthor?: AzureCommitAuthor;

  constructor(config: AzureApiConfig, token: string) {
    this.repo = config.repo;
    this.apiRoot = trim(config.apiRoot, '/') || 'https://dev.azure.com';
    this.endpointUrl = `${this.apiRoot}/${this.repo?.org}/${this.repo?.project}/_apis/git/repositories/${this.repo?.name}`;
    this.token = token || undefined;
    this.branch = config.branch || 'master';
    this.squashMerges = config.squashMerges || true;
    this.initialWorkflowStatus = config.initialWorkflowStatus;
    this.apiVersion = '5.1'; // Azure API version is recommended and sometimes even required
  }

  withAuthorizationHeaders = (req: ApiRequest) =>
    unsentRequest.withHeaders(this.token ? { Authorization: `Bearer ${this.token}` } : {}, req);

  withAzureFeatures = (req: ApiRequest) => {
    req = unsentRequest.withHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Origin': '*'
      }, req);
    req = unsentRequest.withParams({
        'api-version': this.apiVersion
      }, req);
    return req;
  };

  withLogging = (req: ApiRequest) => {
    return req;
  }

  buildRequest = (req: ApiRequest) =>
    flow([
      unsentRequest.withRoot(this.apiRoot),
      this.withAuthorizationHeaders,
      this.withAzureFeatures,
      unsentRequest.withTimestamp,
    ])(req);

  request = async (req: ApiRequest): Promise<Response> =>
    flow([
      this.buildRequest,
      this.withLogging,
      unsentRequest.performRequest,
      p => p.catch((err: Error) => Promise.reject(new APIError(err.message, null, API_NAME))),
    ])(req);

  parseJsonResponse(response: any) {
    return response.json().then((json: any) => {
      if (!response.ok) {
        return Promise.reject(json);
      }
      return json;
    });
  }

  responseToJSON = responseParser({ format: 'json', apiName: API_NAME });
  responseToBlob = responseParser({ format: 'blob', apiName: API_NAME });
  responseToText = responseParser({ format: 'text', apiName: API_NAME });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestJSON = (req: ApiRequest) => this.request(req).then(this.responseToJSON) as Promise<any>;
  requestText = (req: ApiRequest) => this.request(req).then(this.responseToText) as Promise<string>;

  /**
   * Get the name of the current user by hitting the VS /me endpoint. 
   */
  user = (): Promise<AzureUser>  => {
    return this.requestJSON({ url: 'https://app.vssps.visualstudio.com/_apis/profile/profiles/me'}) as Promise<AzureUser>;
  }

  async retrieveMetadata(contentKey: string) {

    console.log(`API.retrieveMetadata(contentKey: "${contentKey}")`);

    const { collection, slug } = parseContentKey(contentKey);
    const branch = this.branchFromContentKey(contentKey);
    const mergeRequest = await this.getBranchMergeRequest(branch);

console.log("Merge request: " + JSON.stringify(mergeRequest));

    const diff = await this.getDifferences(mergeRequest.sourceRefName);
    const path = diff.find(((d: any) => d.old_path.includes(slug))?.old_path as string);
    const mediaFiles = await Promise.all(
      diff
        .filter(d => d.old_path !== path)
        .map(async d => {
          const path = d.new_path;
          const id = await this.getFileId(path, branch);
          return { path, id };
        }),
    );
    const label = mergeRequest.labels.find(isCMSLabel) as string;
    const status = labelToStatus(label);
    return { branch, collection, slug, path, status, mediaFiles };
  }

  /**
   * Reads a single file from an Azure DevOps Git repository, using the 'items' endpoint,
   * with the path to the desired file. Parses the response whether it's a string or blob,
   * and then passes the retrieval function to the central readFile cache.
   * @param path The repo-relative path of the file to read.
   * @param sha  Null. Not used by the Azure implementation.
   * @param opts Override options.
   */
  readFile = async (
    path: string,
    sha?: string | null,
    { parseText = true, branch = this.branch } = {},
  ): Promise<string | Blob> => {
    const fetchContent = async () => {
      console.log(path);
      const content = await this.request({
        url: `${this.endpointUrl}/items/`, 
        params: { version: branch, path: path },
        cache: 'no-store',
      }).then<Blob | string>(parseText ? this.responseToText : this.responseToBlob);
      return content;
    };

    const content = await readFile(sha, fetchContent, localForage, parseText);
    return content;
  };

  listFiles = async (path: string) => {
    return await this.requestJSON({
      url: `${this.endpointUrl}/items/`, 
      params: { version: this.branch, path: path }, // Azure
    }).then(response => {
        // Get the real URL of the tree data and hit it.
        return response._links.tree.href;
      })
      .then ( url => {
        return this.requestJSON(`${url}`);
      })
      .then(response => {
        const files = ( response.treeEntries || [ ]);
        if (!Array.isArray(files)) {
          throw new Error(`Cannot list files, path ${path} is not a directory but a ${files.type}`);
        }
        files.forEach((f: any) => { f.relativePath = `${path}/${f.relativePath}`; });
        console.log(JSON.stringify(files));
        return files;
      })
      .then(files => files.filter(file => file.gitObjectType === 'blob'));    // Azure
  }


  async getRef(branch: string = this.branch): Promise<AzureRef> {
    console.log(`API.getRef(branch: "${branch}")`);
    return this.requestJSON({
      url: `${this.endpointUrl}/refs`,
      params: {
        '$top': "1", '$filter': branch } // Azure hardwired to get expected response format   
    }).then((refs: any) => {
      return first(refs.value.filter((b: any)=> b.name == 'refs/heads/' + branch)) as AzureRef;
    });
  }

  uploadAndCommit(items: any, comment: string = 'Creating new files', branch: string = this.branch) {
      return this.getRef(this.branch).then((ref: AzureRef) => {
        
        ref = ref || { name: 'refs/heads/' + branch, objectId: "0000000000000000000000000000000000000000"};
        
        ref.name = `refs/heads/${branch}`;
        
        var commit = new AzureCommit(comment);

        items.forEach((i: any) => {

          console.log("API.uploadAndCommit: " + i.path);

          switch (i.action as AzureCommitChangeType) {
            case AzureCommitChangeType.ADD:
              commit.changes.addBase64(i.path, i.base64Content);
              break;
            case AzureCommitChangeType.EDIT:
                commit.changes.editBase64(i.path, i.base64Content);
                break;
          }
          
        });

        // Only bother with a request if we're going to make changes.
        if (commit.changes.length > 0) {
          var push = new AzurePush(ref);
          push.commits.push(commit);
              

          console.log(JSON.stringify(push));
          return this.requestJSON({
            url: `${this.endpointUrl}/pushes`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(push)
          });
        }
    });

  }

  async readUnpublishedBranchFile(contentKey: string) {
    console.log(`API.readUnpublishedBranchFile(contentKey: "${contentKey}")`);
    const { branch, collection, slug, path, status, mediaFiles } = await this.retrieveMetadata(contentKey).then(data =>
      data.objects.entry.path ? data : Promise.reject(null),
    );

    const [fileData, isModification] = await Promise.all([
      this.readFile(path, null, { branch }) as Promise<string>,
      this.isFileExists(path, this.branch),
    ]);

    return {
      slug,
      metaData: { branch, collection, objects: { entry: { path, mediaFiles } }, status },
      fileData,
      isModification,
    };

    //return resolvePromiseProperties({
    //  metaData: metaDataPromise,
    //  fileData: metaDataPromise.then(data =>
    //    this.readFile(data.objects.entry.path, null, data.branch),
    //  ),
    //  isModification: metaDataPromise.then(data =>
    //    this.isUnpublishedEntryModification(data.objects.entry.path, this.branch),
    //  ),
    //}).catch(() => {
    //  throw new EditorialWorkflowError('content is not under editorial workflow', true);
    //});
  }

  isUnpublishedEntryModification(path: string, branch: string) {
    console.log(`API.isUnpublishedEntryModification(path: ${path}, branch: ${branch})`);
    return this.readFile(path, null, { branch: branch })
      .then(() => true)
      .catch((err: Error) => {
        if (err.message && err.message === 'Not Found') {
          return false;
        }
        throw err;
      });
  }

  /**
   * Retrieve statuses for a given SHA. Unrelated to the editorial workflow
   * concept of entry "status". Useful for things like deploy preview links.
   */
  async getStatuses(sha: string) {
    const resp = await this.requestJSON(`${this.endpointUrl}/commits/${sha}/status`);
    return resp.statuses;
  }

  composeFileTree(files: any) {
    let filename;
    let part;
    let parts;
    let subtree: any;
    const fileTree = {};

    files.forEach((file : any) => {
      if (file.uploaded) {
        return;
      }
      parts = file.path.split('/').filter((part: any) => part);
      filename = parts.pop();
      subtree = fileTree;
      while ((part = parts.shift())) {
        // eslint-disable-line no-cond-assign
        subtree[part] = subtree[part] || {};
        subtree = subtree[part];
      }
      subtree[filename] = file;
      file.file = true;
    });

    return fileTree;
  }

  async getCommitItems(files: (Entry | AssetProxy)[], branch: string) {
    const items = await Promise.all(
      files.map(async file => {
        const [base64Content, fileExists] = await Promise.all([
          result(file, 'toBase64', partial(this.toBase64, (file as Entry).raw)),
          this.isFileExists(file.path, branch),
        ]);
        return {
          action: fileExists ? AzureCommitChangeType.EDIT : AzureCommitChangeType.ADD,
          base64Content,
          path: '/' + trim(file.path, '/'),
        };
      }),
    );
    return items as any[];
  }

  /**
   * Store a resource in the target repository.
   * @param entry 
   * @param mediaFiles 
   * @param options 
   */
  async persistFiles(entry: Entry | null, mediaFiles: AssetProxy[], options: PersistOptions) {
    const files = entry ? [entry, ...mediaFiles] : mediaFiles;
    if (options.useWorkflow) {
      return this.editorialWorkflowGit(files, entry as Entry, options);
    } else {
      const items = await this.getCommitItems(files, this.branch);
      return this.uploadAndCommit(items, options.commitMessage);
    }
  }

  deleteFile(path: string, comment: string, branch = this.branch) {
    return this.getRef().then((ref: AzureRef) => {

      var commit = new AzureCommit(comment);
      commit.changes.delete(path);
      
      var push = new AzurePush(ref);
      push.commits.push(commit);

      return this.requestJSON({
          url: `${this.endpointUrl}/pushes`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(push)
      });
    });
  }

  generateContentKey(collectionName: string, slug: string) {
    return generateContentKey(collectionName, slug);
  }

  contentKeyFromBranch(branch: string) {
    return branch.substring(`${CMS_BRANCH_PREFIX}/`.length);
  }

  branchFromContentKey(contentKey: string) {
    return `${CMS_BRANCH_PREFIX}/${contentKey}`;
  }

  async getMergeRequests(sourceBranch?: string) {
    const mergeRequests = await this.requestJSON({
      url: `${this.endpointUrl}/pullrequests`,
      params: {
        'searchCriteria.status': 'active',
        // eslint-disable-next-line @typescript-eslint/camelcase
        'searchCriteria.targetRefName': `refs/heads/${this.branch}`,
        'searchCriteria.includeLinks': false,
        // eslint-disable-next-line @typescript-eslint/camelcase
        ...(sourceBranch ? { 'searchCriteria.sourceRefName': `refs/heads/${sourceBranch}` } : {}),
      },
    });

    //&& mr.labels.some(isCMSLabel)
    console.log(JSON.stringify(mergeRequests.value));
    return mergeRequests.value.filter(
      (mr : any) => mr.sourceRefName.startsWith(`refs/heads/${CMS_BRANCH_PREFIX}`) ,
    );
  }

  /**
   * 
   */
  async listUnpublishedBranches() {
    console.log(`API.listUnpublishedBranches()`);

    const mergeRequests = await this.getMergeRequests();

    console.log(mergeRequests);
    const branches = mergeRequests.map((mr: any) => mr.sourceRefName.replace('refs/heads/', ''));

    return branches;
  }
  
  async getFileId(path: string, branch: string) {
    console.log(`API.getFileId(path: "${path}", branch: "${branch}")`);
    const file = await this.request({
      url: `${this.endpointUrl}/items/`,
      params: { version: branch, path: path },
      cache: 'no-store',
    });

    console.log(file);
    const blobId = file.objectId;
    return blobId;
  }

  async isFileExists(path: string, branch: string) {
    console.log(`API.isFileExists(path: "${path}", branch: "${branch}")`);
    return await this.requestText({
      url: `${this.endpointUrl}/items/`,
      params: { version: branch, path: path },
      cache: 'no-store',
    })
      .then((r) => { console.log(`isFileExists: ${JSON.stringify(r)}`); return true; })
      .catch(error => {
        if (error instanceof APIError && error.status === 404) {
          console.log("isFileExists: false");
          return false;
        }
        console.log("isFileExists: error");
        throw error;
      });
  }

  async createMergeRequest(branch: string, commitMessage: string, status: string) {

    console.log(`API.createMergeRequest(branch: "${branch}", commitMessage: "${commitMessage}", status: "${status}")`);
    const pr = {
      "sourceRefName": "refs/heads/" + branch,
      "targetRefName": "refs/heads/" + this.branch,
      "title": commitMessage,
      "reviewers": [
        {
          "id": (await this.user()).id
        }
      ],
      "completionOptions": {
        "deleteSourceBranch": true,
        "mergeStrategy": this.squashMerges ? "squash" : "noFastForward" 
      }
    };

    await this.requestJSON({
      method: 'POST',
      url: `${this.endpointUrl}/pullrequests`,
      params: {
        supportsIterations: false
      },
      body: JSON.stringify(pr)
    });
  }

  async getBranchMergeRequest(branch: string) {
    console.log(`API.getBranchMergeRequest(branch: "${branch}")`);
    const mergeRequests = await this.getMergeRequests(branch);
    if (mergeRequests.length <= 0) {
      throw new EditorialWorkflowError('content is not under editorial workflow', true);
    }

    return mergeRequests[0];
  }

  async getDifferences(to: string) {
    const result = await this.requestJSON({
      url: `${this.endpointUrl}/diffs/commits`,
      params: {
        "baseVersion": `${this.branch}`,
        "targetVersion": to.replace('refs/heads/', '')
      }
    });

console.log(JSON.stringify(result))
    return result.changes;
  }

  async editorialWorkflowGit(files: (Entry | AssetProxy)[], entry: Entry, options: PersistOptions) {

    console.log(`API.editorialWorkflowGit`);

    const contentKey = this.generateContentKey(options.collectionName as string, entry.slug);
    const branch = this.branchFromContentKey(contentKey);

    const unpublished = options.unpublished || false;
    if (!unpublished) {
      const items = await this.getCommitItems(files, this.branch);
      
      // This will be a new branch, might have to create it first.
      await this.uploadAndCommit(
        items,
        options.commitMessage,
        branch
      );

      await this.createMergeRequest(
        branch,
        options.commitMessage,
        options.status || this.initialWorkflowStatus,
      );

    } else {
      const mergeRequest = await this.getBranchMergeRequest(branch);
      //await this.rebaseMergeRequest(mergeRequest);
      //const [items, diffs] = await Promise.all([
      //  this.getCommitItems(files, branch),
      //  this.getDifferences(branch),
      //]);

      // mark files for deletion
      //for (const diff of diffs) {
      //  if (!items.some(item => item.path === diff.new_path)) {
      //    items.push({ action: CommitAction.DELETE, path: diff.new_path });
      //  }
      //}

      //await this.uploadAndCommit(items, {
      //  commitMessage: options.commitMessage.commitMessage,
      //  branch,
      //});
    }
  }

  /**
   * Rebase a pull request onto the latest HEAD of it's target base branch
   * (should generally be the configured backend branch). Only rebases changes
   * in the entry file.
   */
  async rebasePullRequest(prNumber: any, branchName: string, contentKey: string, metadata: any, head: string) {
    const { path } = metadata.objects.entry;

    try {
      /**
       * Get the published branch and create new commits over it. If the pull
       * request is up to date, no rebase will occur.
       */
      const baseBranch = await this.getBranch();
      const commits = await this.getPullRequestCommits(prNumber);//, head);

      /**
       * Sometimes the list of commits for a pull request isn't updated
       * immediately after the PR branch is patched. There's also the possibility
       * that the branch has changed unexpectedly. We account for both by adding
       * the head if it's missing, or else throwing an error if the PR head is
       * neither the head we expect nor its parent.
       */
      const finalCommits = this.assertHead(commits, head);
      const rebasedHead = await this.rebaseSingleBlobCommits(baseBranch.commit, finalCommits, path);

      /**
       * Update metadata, then force update the pull request branch head.
       */
      const pr = { ...metadata.pr, head: rebasedHead.sha };
      const timeStamp = new Date().toISOString();
      const updatedMetadata = { ...metadata, pr, timeStamp };
      //await this.storeMetadata(contentKey, updatedMetadata);
      return this.patchBranch(branchName, rebasedHead.sha, { force: true });
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Rebase an array of commits one-by-one, starting from a given base SHA. Can
   * accept an array of commits as received from the GitHub API. All commits are
   * expected to change the same, single blob.
   */
  rebaseSingleBlobCommits(baseCommit: any, commits: any, pathToBlob: string) {
    /**
     * If the parent of the first commit already matches the target base,
     * return commits as is.
     */
    if (commits.length === 0 || commits[0].parents[0].sha === baseCommit.sha) {
      return Promise.resolve(last(commits));
    }

    /**
     * Re-create each commit over the new base, applying each to the previous,
     * changing only the parent SHA and tree for each, but retaining all other
     * info, such as the author/committer data.
     */
    const newHeadPromise = commits.reduce((lastCommitPromise: any, commit: any) => {
      return lastCommitPromise.then((newParent: any) => {
        /**
         * Normalize commit data to ensure it's not nested in `commit.commit`.
         */
        const parent = this.normalizeCommit(newParent);
        const commitToRebase = this.normalizeCommit(commit);

        return this.rebaseSingleBlobCommit(parent, commitToRebase, pathToBlob);
      });
    }, Promise.resolve(baseCommit));

    /**
     * Return a promise that resolves when all commits have been created.
     */
    return newHeadPromise;
  }

  /**
   * Rebase a commit that changes a single blob. Also handles updating the tree.
   */
  rebaseSingleBlobCommit(baseCommit: any, commit: any, pathToBlob: string) {
    /**
     * Retain original commit metadata.
     */
    const { message, author, committer } = commit;

    /**
     * Set the base commit as the parent.
     */
    const parent = [baseCommit.sha];

    /**
     * Get the blob data by path.
     */
    return (
      this.getBlobInTree(commit.tree.sha, pathToBlob)

        /**
         * Create a new tree consisting of the base tree and the single updated
         * blob. Use the full path to indicate nesting, GitHub will take care of
         * subtree creation.
         */
        .then((blob: any) => this.createTree(baseCommit.tree.sha, [{ ...blob, path: pathToBlob }]))

        /**
         * Create a new commit with the updated tree and original commit metadata.
         */
        .then((tree: any) => this.createCommit(message, tree.sha, parent, author, committer))
    );
  }

  /**
   * Get a pull request by PR number.
   */
  getPullRequest(prNumber: string) {
    return this.requestJSON({ url: `${this.endpointUrl}/pulls/${prNumber}` });
  }

  /**
   * Get the list of commits for a given pull request.
   */
  getPullRequestCommits(prNumber: string) {
    return this.requestJSON({ url: `${this.endpointUrl}/pulls/${prNumber}/commits` });
  }

  /**
   * Returns `commits` with `headToAssert` appended if it's the child of the
   * last commit in `commits`. Returns `commits` unaltered if `headToAssert` is
   * already the last commit in `commits`. Otherwise throws an error.
   */
  assertHead(commits: any[], headToAssert: any) {
    const headIsMissing = headToAssert.parents[0].sha === last(commits).sha;
    const headIsNotMissing = headToAssert.sha === last(commits)?.sha;

    if (headIsMissing) {
      return commits.concat(headToAssert);
    } else if (headIsNotMissing) {
      return commits;
    }

    throw Error('Editorial workflow branch changed unexpectedly.');
  }

  updateUnpublishedEntryStatus(collection: any, slug: string, status: any) {
    const contentKey = slug;
    return this.retrieveMetadata(contentKey)
      .then(metadata => ({
        ...metadata,
        status,
      }));
      //.then(updatedMetadata => this.storeMetadata(contentKey, updatedMetadata));
  }

  deleteUnpublishedEntry(collectionName: any, slug: string) {
    const contentKey = this.generateContentKey(collectionName, slug);
    const branch = this.branchFromContentKey(contentKey);
    //const mergeRequest = await this.getBranchMergeRequest(branch);
    //await this.closeMergeRequest(mergeRequest);
    //await this.deleteBranch(branch);
  }

  async publishUnpublishedEntry(collectionName: string, slug: string) {
    console.log(`API.publishUnpublishedEntry("collectionName: ${collectionName}", slug: "${slug}")`);

    const contentKey = this.generateContentKey(collectionName, slug);
    const branch = this.branchFromContentKey(contentKey);
    //const mergeRequest = await this.getBranchMergeRequest(branch);
    //await this.mergeMergeRequest(mergeRequest);
  }
  

  createRef(type: string, name: string, sha: string) {
    console.log(`API.createRef(${type}, ${name}, ${sha})`);
    return this.request({
      url: `${this.endpointUrl}/refs`,
      method: 'POST',
      body: JSON.stringify({ name: `refs/${type}/${name}`, oldObjectId: "0000000000000000000000000000000000000000", newObjectId: sha }),
    });
  }

  patchRef(type: string, name: string, sha: string, opts = { force: false }) {
    console.log(`API.patchRef(${type}, ${name}, ${sha}, ${JSON.stringify(opts)})`);
    const force = opts.force || false;
    return this.requestJSON({
      url: `${this.endpointUrl}/git/refs/${type}/${encodeURIComponent(name)}`, 
      method: 'PATCH',
      body: JSON.stringify({ sha, force }),
    });
  }

  deleteRef(type: string, name: string) {
    console.log(`API.deleteRef(${type}, ${name})`);
    return this.requestJSON({
      url: `${this.endpointUrl}/git/refs/${type}/${encodeURIComponent(name)}`,
      method: 'DELETE'
    });
  }

  getBranch(branch: string = this.branch) {
    console.log(`API.getBranch(${branch})`);
    return this.requestJSON(`${this.endpointUrl}/branches/${encodeURIComponent(branch)}`);
  }

  createBranch(branchName: string, sha: string) {
    console.log(`API.createBranch(${branchName}, ${sha})`);
    return this.createRef('heads', branchName, sha);
  }

  assertCmsBranch(branchName: string) {
    return branchName.startsWith(CMS_BRANCH_PREFIX);
  }

  patchBranch(branchName: string, sha: string, opts = { force: false }) {
    const force = opts.force || false;
    if (force && !this.assertCmsBranch(branchName)) {
      throw Error(`Only CMS branches can be force updated, cannot force update ${branchName}`);
    }
    return this.patchRef('heads', branchName, sha, { force });
  }

  deleteBranch(branchName: string) {
    return this.deleteRef('heads', branchName);
  }

  createPR(title: string, head: string, base = this.branch) {
    const body = 'Automatically generated by Netlify CMS';
    return this.requestJSON({
      url: `${this.endpointUrl}/pulls`,
      method: 'POST',
      body: JSON.stringify({ title, body, head, base }),
    });
  }

  closePR(pullrequest: any) {
    const prNumber = pullrequest.number;
    console.log('%c Deleting PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.request({
      url: `${this.endpointUrl}/pulls/${prNumber}`,
      method: 'PATCH',
      body: JSON.stringify({
        state: closed,
      }),
    });
  }

  mergePR(pullrequest: any, objects: any) {
    const headSha = pullrequest.head;
    const prNumber = pullrequest.number;
    console.log('%c Merging PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.requestJSON({
      url: `${this.endpointUrl}/pulls/${prNumber}/merge`,
      method: 'PUT',
      body: JSON.stringify({
        commit_message: 'Automatically generated. Merged on Netlify CMS.',
        sha: headSha,
        merge_method: this.squashMerges,
      }),
    }).catch(error => {
      if (error instanceof APIError && error.status === 405) {
        return this.forceMergePR(pullrequest, objects);
      } else {
        throw error;
      }
    });
  }

  forceMergePR(pullrequest: any, objects: any) {
    const files = objects.files.concat(objects.entry);
    const fileTree = this.composeFileTree(files);
    let commitMessage = 'Automatically generated. Merged on Netlify CMS\n\nForce merge of:';
    files.forEach((file: any) => {
      commitMessage += `\n* "${file.path}"`;
    });
    console.log(
      '%c Automatic merge not possible - Forcing merge.',
      'line-height: 30px;text-align: center;font-weight: bold',
    );
    return this.getBranch()
      .then(branchData => this.updateTree(branchData.commit.sha, '/', fileTree))
      .then(changeTree => this.commit(commitMessage, changeTree))
      .then(response => this.patchBranch(this.branch, response.sha));
  }

  getTree(sha: string) {
    if (sha) {
      return this.requestJSON({
        url: `${this.endpointUrl}/git/trees/${sha}`
      });
    }
    return Promise.resolve({ tree: [] });
  }

  /**
   * Get a blob from a tree. Requests individual subtrees recursively if blob is
   * nested within one or more directories.
   */
  getBlobInTree(treeSha: any, pathToBlob: string) {
    const pathSegments = pathToBlob.split('/').filter(val => val);
    const directories = pathSegments.slice(0, -1);
    const filename = pathSegments.slice(-1)[0];
    const baseTree = this.getTree(treeSha);
    const subTreePromise = directories.reduce((treePromise: any, segment: any) => {
      return treePromise.then((tree: any) => {
        const subTreeSha = find(tree.tree, { path: segment }).sha;
        return this.getTree(subTreeSha);
      });
    }, baseTree);
    return subTreePromise.then((subTree: any) => find(subTree.tree, { path: filename }));
  }

  toBase64 = (str: string) => Promise.resolve(Base64.encode(str));
  fromBase64 = (str: string) => Base64.decode(str);

  uploadBlob(item: any) {
    const content = result(item, 'toBase64', partial(this.toBase64, item.raw));

    return content.then(contentBase64 =>
      this.requestJSON({
        url: `${this.endpointUrl}/git/blobs`,
        method: 'POST',
        body: JSON.stringify({
          content: contentBase64,
          encoding: 'base64',
        }),
      }).then(response => {
        item.sha = response.sha;
        item.uploaded = true;
        return item;
      }),
    );
  }

  updateTree(sha: string | null, path: string, fileTree: any): any {

    if (!sha) { throw new Error('You need a sha, apparently');}
    return this.getTree(sha).then((tree : any) => {
      let obj;
      let filename;
      let fileOrDir;
      const updates = [];
      const added: any = {};

      for (let i = 0, len = tree.tree.length; i < len; i++) {
        obj = tree.tree[i];
        if ((fileOrDir = fileTree[obj.path])) {
          // eslint-disable-line no-cond-assign
          added[obj.path] = true;
          if (fileOrDir.file) {
            updates.push({ path: obj.path, mode: obj.mode, type: obj.type, sha: fileOrDir.sha });
          } else {
            updates.push(this.updateTree(obj.sha, obj.path, fileOrDir));
          }
        }
      }
      for (filename in fileTree) {
        fileOrDir = fileTree[filename];
        if (added[filename]) {
          continue;
        }
        updates.push(
          fileOrDir.file
            ? { path: filename, mode: '100644', type: 'blob', sha: fileOrDir.sha }
            : this.updateTree(null, filename, fileOrDir),
        );
      }
      return Promise.all(updates)
        .then(tree => this.createTree(sha, tree))
        .then(response => ({
          path,
          mode: '040000',
          type: 'tree',
          sha: response.sha,
          parentSha: sha,
        }));
    });
  }

  createTree(baseSha: string, tree: any) {
    return this.requestJSON({
      url: `${this.endpointUrl}/git/trees`,
      method: 'POST',
      body: JSON.stringify({ base_tree: baseSha, tree }),
    });
  }

  /**
   * Some GitHub API calls return commit data in a nested `commit` property,
   * with the SHA outside of the nested property, while others return a
   * flatter object with no nested `commit` property. This normalizes a commit
   * to resemble the latter.
   */
  normalizeCommit(commit: any) {
    if (commit.commit) {
      return { ...commit.commit, sha: commit.sha };
    }
    return commit;
  }

  commit(message: string, changeTree: any) {
    const parents = changeTree.parentSha ? [changeTree.parentSha] : [];
    return this.createCommit(message, changeTree.sha, parents, null, null);
  }

  createCommit(message: string, treeSha: string, parents: any, author: any, committer: any) {
    return this.requestJSON({
      url: `${this.endpointUrl}/git/commits`,
      method: 'POST',
      body: JSON.stringify({ message, tree: treeSha, parents, author, committer }),
    });
  }

  // In Azure we don't always have the SHA resp ID handy
  // this function is to get the ObjectId and CommitId (output)
  // from path and branch (input)
  getAzureId(path: string, branch: string = this.branch ) {
    console.log("API.getAzureId")
    return this.requestJSON({
      url: `${this.endpointUrl}/items`,
      params: { version: this.branch, path: path,
        '$format': "json", versionType: "Branch", versionOptions: "None" } // Azure hardwired to get expected response format   
    });
  }
}
