import { Base64 } from 'js-base64';
import { uniq, initial, last, get, find, flow, some, partial, result, trim } from 'lodash';
import {
  localForage,
  APIError,
  ApiRequest,
  unsentRequest,
  responseParser,
  EditorialWorkflowError,
  Config,
  readFile,
  CMS_BRANCH_PREFIX
} from 'netlify-cms-lib-util';


export const API_NAME = 'Azure DevOps';

// from here you can navigate trees, looking for blobs
// https://dev.azure.com/{tenant}/{project}/_apis/git/repositories/{repo}/items?path=/&version={branch}&api-version=5.0

// or to specify known folder
// https://dev.azure.com/{tenant}/{project}/_apis/git/repositories/{repo}}/items?path={path}&version=[branch]&api-version=5.0

// or to specify recursionLevel (WTF that does all options return same json, no recusion into scopePath, on my repo)
// https://dev.azure.com/{tenant}/{project}/_apis/git/repositories/{repo}}/items?scopePath=/content&recursionLevel=oneLevel&version=[branch]&api-version=5.0

class AzureRepo {
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

export default class API {

  apiRoot: string;
  apiVersion: string;
  token?: string;
  branch: string;
  mergeMethod: string;
  repo?: AzureRepo;
  endpointUrl: string;
  initialWorkflowStatus: string;

  constructor(config: Config, token: string, options: any) {
    this.repo = new AzureRepo(config.backend.repo);
    this.apiRoot = trim(config.backend.api_root, '/') || 'https://dev.azure.com';
    this.endpointUrl = `${this.apiRoot}/${this.repo?.org}/${this.repo?.project}/_apis/git/repositories/${this.repo?.name}`;
    this.token = token || undefined;
    this.branch = config.backend.branch || 'master';
    this.mergeMethod = config.backend.squash_merges ? 'squash' : 'merge';
    this.initialWorkflowStatus = options.initiaWorkflowStatus;
    this.apiVersion = '5.0'; // Azure API version is recommended and sometimes even required
  }

  withAuthorizationHeaders = (req: ApiRequest) =>
    unsentRequest.withHeaders(this.token ? { Authorization: `Bearer ${this.token}` } : {}, req);

  withAzureFeatures = (req: ApiRequest) => {
    unsentRequest.withHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Origin': '*'
      }, req);
    unsentRequest.withParams({
        'api-version': this.apiVersion
      }, req);
  };
  
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

  user = () => this.requestJSON('https://graph.microsoft.com/v1.0/me');

  //urlFor(path: string, options: any) {
  //  const cacheBuster = new Date().getTime();
  //  const params = [`ts=${cacheBuster}&api-version=${this.apiVersion}`]; // added Azure specific api-version
  //  let pathext;
  //  if (options.params) {
  //    for (const key in options.params) {
  //      params.push(`${key}=${encodeURIComponent(options.params[key])}`);
  //    }
  //  }
  //  if (params.length) {
  //    pathext = `${params.join('&')}`;
  //  }
  //  if (path.match(/^https/)) { // Azure specific - path may already be a fully qualified URL 
  //    path +=  `?${pathext}`; // assume we have already one divider '?'
  //  } else {
  //    path = this.apiRoot + path +  `?${pathext}`;
  //  }
  //  console.log('** DEBUG azure urlFor  -- path = ' + path + ' -- options: ' + JSON.stringify( options )  );
  //  return path;
  //  // return this.api_root + path;
  //  }

  //request(path: string, options: any = {}) {
  //  const headers = this.requestHeaders(options.headers || {});
  //  console.log('**DEBUG entering req path: ' + path +   ' -- options: ' + JSON.stringify( options ) );
  //  const url = this.urlFor(path, options);
	//  options.mode = 'cors'; // Azure ensure headers are set to get suitable response
  //  let responseStatus: number = 0;
  //  return fetch(url, { ...options, headers })
  //    .then(response => {
  //      responseStatus = response.status;
  //      const contentType = response.headers.get('Content-Type');
  //      if (contentType && contentType.match(/json/)) {
  //        return this.parseJsonResponse(response);
  //      }
  //      const text = response.text();
  //      console.log('**DEBUG hm, req response was text not json: ' + JSON.stringify( text ) );
  //      if (!response.ok) {
  //        return Promise.reject(text);
  //      }
  //      return text;
  //    })
  //    .catch(error => {
  //      console.log('**DEBUG: request catch ' + url + error.message + responseStatus);
  //      throw new APIError(error.message, responseStatus, 'Azure');
  //    });
  //}

  generateBranchName(basename: string) {
    return `${CMS_BRANCH_PREFIX}${basename}`;
  }

  retrieveMetadata(contentKey: string) {
    const cache = localForage.getItem(`gh.meta.${contentKey}`);
    return cache.then((cached: any) => {
      if (cached && cached.expires > Date.now()) {
        return cached.data;
      }
      console.log(
        '%c Checking for MetaData files',
        'line-height: 30px;text-align: center;font-weight: bold',
      );
      return this.requestJSON({
        url: `${this.endpointUrl}/items/${contentKey}.json`,
        params: { version: 'refs/meta/_netlify_cms' },
        headers: { Accept: 'application/vnd.github.VERSION.raw' },
        cache: 'no-store',
      })
        .then(response => JSON.parse(response))
        .catch(() =>
          console.log(
            '%c %s does not have metadata',
            'line-height: 30px;text-align: center;font-weight: bold',
            contentKey,
          ),
        );
    });
  }

  readFile = async (
    path: string,
    sha?: string | null,
    { parseText = true, branch = this.branch } = {},
  ): Promise<string | Blob> => {
    const fetchContent = async () => {
      const content = await this.requestJSON({
        url: `${this.endpointUrl}/items/${encodeURIComponent(path)}`,
        params: { version: branch },
        cache: 'no-store',
      }).then<Blob | string>(parseText ? this.responseToText : this.responseToBlob);
      return content;
    };

    const content = await readFile(sha, fetchContent, localForage, parseText);
    return content;
  };

  //readFile(path: string, sha: string, branch = this.branch) {
  //  if (sha) {
  //    return this.getBlob(sha, path); // Azure if we have ObjId = sha then we usually already have an URL, too
  //  } else {
  //    return this.requestJSON({
  //      url: `${this.endpointUrl}/items/${path}`,
  //      headers: { Accept: 'application/vnd.github.VERSION.raw' },
  //      params: { version: branch },
  //      cache: 'no-store',
  //    }).catch(error => { // Azure - not sure if we will ever get beyond this point
  //      if (hasIn(error, 'message.errors') && find(error.message.errors, { code: 'too_large' })) {
  //        const dir = path
  //          .split('/')
  //          .slice(0, -1)
  //          .join('/');
  //        return this.listFiles(dir)
  //          .then(files => files.find(file => file.path === path))
  //          .then(file => this.getBlob(file.sha, file.path));
  //      }
  //      throw error;
  //    });
  //  }
  //}

  //getBlob(sha: string, url: string) { // In Azure we don't have the ObjectId = sha handy always - caution !
    // Azure - disable caching as long as we cannot ensure a valid ObjId = sha always
    // return localForage.getItem(`gh.${sha}`).then(cached => {
    //  if (cached) {
    //    return cached;
    //  }

      // return this.request(`${this.repoURL}/git/blobs/${sha}`, {
    //    return this.request(`${url}`, { // Azure
    //      headers: { Accept: 'application/vnd.github.VERSION.raw' },
    //  }).then(result => {
    //    localForage.setItem(`gh.${sha}`, result);
    //    return result;
    //  });
    // });
  //}

  listFiles = async (path: string) => {
    // return this.request(`${this.repoURL}/contents/${path.replace(/\/$/, '')}`, {
    return await this.requestJSON({
      url: `${this.endpointUrl}/items/`, 
      params: { version: this.branch, path: path }, // Azure
    }).then(response => {
      console.log('**DEBUG: getTreeId -- returnObj: ' + JSON.stringify(response) )
        return response._links.tree.href 
      })
      .then ( url => {
         console.log('**DEBUG: list files  -- url: ' + url )
        return this.requestJSON(`${url}`);
      })
      .then(response => {
        const files = ( response.treeEntries || [ ]);
        console.log('** DEBUG - treeEntries ' + JSON.stringify(files) );
        if (!Array.isArray(files)) {
          throw new Error(`Cannot list files, path ${path} is not a directory but a ${files.type}`);
        }
        return files;
      })
      .then(files => files.filter(file => file.gitObjectType === 'blob'));    // Azure
  }

  async readUnpublishedBranchFile(contentKey: string) {
    const metaData = await this.retrieveMetadata(contentKey).then(data =>
      data.objects.entry.path ? data : Promise.reject(null),
    );

    const [fileData, isModification] = await Promise.all([
      this.readFile(metaData.path, null, { branch: metaData.branch }) as Promise<string>,
      this.isFileExists(metaData.path, this.branch),
    ]);

    return {
      slug: metaData.slug,
      metaData: { branch, collection, objects: { entry: { path, mediaFiles } }, status },
      fileData,
      isModification,
    };

    return resolvePromiseProperties({
      metaData: metaDataPromise,
      fileData: metaDataPromise.then(data =>
        this.readFile(data.objects.entry.path, null, data.branch),
      ),
      isModification: metaDataPromise.then(data =>
        this.isUnpublishedEntryModification(data.objects.entry.path, this.branch),
      ),
    }).catch(() => {
      throw new EditorialWorkflowError('content is not under editorial workflow', true);
    });
  }

  isUnpublishedEntryModification(path: string, branch: string) {
    return this.readFile(path, null, { branch: branch })
      .then(() => true)
      .catch((err: Error) => {
        if (err.message && err.message === 'Not Found') {
          return false;
        }
        throw err;
      });
  }

  listUnpublishedBranches() {
    console.log(
      '%c Checking for Unpublished entries',
      'line-height: 30px;text-align: center;font-weight: bold',
    );
    return this.requestJSON(`${this.endpointUrl}/git/refs/heads/cms`)
      .then(() =>
        filterPromises((branches: any, branch: any) => {
          const branchName = branch.ref.substring('/refs/heads/'.length - 1);

          // Get PRs with a `head` of `branchName`. Note that this is a
          // substring match, so we need to check that the `head.ref` of
          // at least one of the returned objects matches `branchName`.
          return this.requestJSON({
            url: `${this.endpointUrl}/pulls`, 
            params: {
              head: branchName,
              state: 'open',
              base: this.branch,
            },
          }).then(prs => prs.some((pr: any) => pr.head.ref === branchName));
        }),
      )
      .catch(error => {
        console.log(
          '%c No Unpublished entries',
          'line-height: 30px;text-align: center;font-weight: bold',
        );
        throw error;
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

  persistFiles(entry, mediaFiles, options) {
    const uploadPromises = [];
    const files = entry ? mediaFiles.concat(entry) : mediaFiles;

    files.forEach(file => {
      if (file.uploaded) {
        return;
      }
      uploadPromises.push(this.uploadBlob(file));
    });

    const fileTree = this.composeFileTree(files);

    return Promise.all(uploadPromises).then(() => {
      if (!options.useWorkflow) {
        return this.getBranch()
          .then(branchData => this.updateTree(branchData.commit.sha, '/', fileTree))
          .then(changeTree => this.commit(options.commitMessage, changeTree))
          .then(response => this.patchBranch(this.branch, response.sha));
      } else {
        const mediaFilesList = mediaFiles.map(file => ({ path: file.path, sha: file.sha }));
        return this.editorialWorkflowGit(fileTree, entry, mediaFilesList, options);
      }
    });
  }

  deleteFile(path, message, options = {}) {
    const branch = options.branch || this.branch;
    const pathArray = path.split('/');
    const filename = last(pathArray);
    const directory = initial(pathArray).join('/');
    const fileDataPath = encodeURIComponent(directory);
    const fileDataURL = `${this.endpointUrl}/git/trees/${branch}:${fileDataPath}`;
    const fileURL = `${this.endpointUrl}/contents/${path}`;

    /**
     * We need to request the tree first to get the SHA. We use extended SHA-1
     * syntax (<rev>:<path>) to get a blob from a tree without having to recurse
     * through the tree.
     */
    return this.request(fileDataURL, { cache: 'no-store' }).then(resp => {
      const { sha } = resp.tree.find(file => file.path === filename);
      const opts = { method: 'DELETE', params: { sha, message, branch } };
      if (this.commitAuthor) {
        opts.params.author = {
          ...this.commitAuthor,
          date: new Date().toISOString(),
        };
      }
      return this.request(fileURL, opts);
    });
  }

  editorialWorkflowGit(fileTree, entry, filesList, options) {
    const contentKey = entry.slug;
    const branchName = this.generateBranchName(contentKey);
    const unpublished = options.unpublished || false;
    if (!unpublished) {
      // Open new editorial review workflow for this entry - Create new metadata and commit to new branch`
      let prResponse: any;

      return this.getBranch()
        .then(branchData => this.updateTree(branchData.commit.sha, '/', fileTree))
        .then(changeTree => this.commit(options.commitMessage, changeTree))
        .then(commitResponse => this.createBranch(branchName, commitResponse.sha))
        .then(() => this.createPR(options.commitMessage, branchName))
        .then(pr => {
          prResponse = pr;
          return this.user();
        })
        .then(user => {
          return this.storeMetadata(contentKey, {
            type: 'PR',
            pr: {
              number: prResponse.number,
              head: prResponse.head && prResponse.head.sha,
            },
            user: user.name || user.login,
            status: this.initialWorkflowStatus,
            branch: branchName,
            collection: options.collectionName,
            title: options.parsedData && options.parsedData.title,
            description: options.parsedData && options.parsedData.description,
            objects: {
              entry: {
                path: entry.path,
                sha: entry.sha,
              },
              files: filesList,
            },
            timeStamp: new Date().toISOString(),
          });
        });
    } else {
      // Entry is already on editorial review workflow - just update metadata and commit to existing branch
      let newHead;
      return this.getBranch(branchName)
        .then(branchData => this.updateTree(branchData.commit.sha, '/', fileTree))
        .then(changeTree => this.commit(options.commitMessage, changeTree))
        .then(commit => {
          newHead = commit;
          return this.retrieveMetadata(contentKey);
        })
        .then(metadata => {
          const { title, description } = options.parsedData || {};
          const metadataFiles = get(metadata.objects, 'files', []);
          const files = [...metadataFiles, ...filesList];
          const pr = { ...metadata.pr, head: newHead.sha };
          const objects = {
            entry: { path: entry.path, sha: entry.sha },
            files: uniq(files),
          };
          const updatedMetadata = { ...metadata, pr, title, description, objects };

          /**
           * If an asset store is in use, assets are always accessible, so we
           * can just finish the persist operation here.
           */
          if (options.hasAssetStore) {
            return this.storeMetadata(contentKey, updatedMetadata).then(() =>
              this.patchBranch(branchName, newHead.sha),
            );
          }

          /**
           * If no asset store is in use, assets are being stored in the content
           * repo, which means pull requests opened for editorial workflow
           * entries must be rebased if assets have been added or removed.
           */
          return this.rebasePullRequest(pr.number, branchName, contentKey, metadata, newHead);
        });
    }
  }

  /**
   * Rebase a pull request onto the latest HEAD of it's target base branch
   * (should generally be the configured backend branch). Only rebases changes
   * in the entry file.
   */
  async rebasePullRequest(prNumber, branchName, contentKey, metadata, head) {
    const { path } = metadata.objects.entry;

    try {
      /**
       * Get the published branch and create new commits over it. If the pull
       * request is up to date, no rebase will occur.
       */
      const baseBranch = await this.getBranch();
      const commits = await this.getPullRequestCommits(prNumber, head);

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
      await this.storeMetadata(contentKey, updatedMetadata);
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
  rebaseSingleBlobCommits(baseCommit, commits, pathToBlob) {
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
    const newHeadPromise = commits.reduce((lastCommitPromise, commit) => {
      return lastCommitPromise.then(newParent => {
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
  rebaseSingleBlobCommit(baseCommit, commit, pathToBlob) {
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
        .then(blob => this.createTree(baseCommit.tree.sha, [{ ...blob, path: pathToBlob }]))

        /**
         * Create a new commit with the updated tree and original commit metadata.
         */
        .then(tree => this.createCommit(message, tree.sha, parent, author, committer))
    );
  }

  /**
   * Get a pull request by PR number.
   */
  getPullRequest(prNumber) {
    return this.request(`${this.repoURL}/pulls/${prNumber} }`);
  }

  /**
   * Get the list of commits for a given pull request.
   */
  getPullRequestCommits(prNumber) {
    return this.request(`${this.repoURL}/pulls/${prNumber}/commits`);
  }

  /**
   * Returns `commits` with `headToAssert` appended if it's the child of the
   * last commit in `commits`. Returns `commits` unaltered if `headToAssert` is
   * already the last commit in `commits`. Otherwise throws an error.
   */
  assertHead(commits, headToAssert) {
    const headIsMissing = headToAssert.parents[0].sha === last(commits).sha;
    const headIsNotMissing = headToAssert.sha === last(commits).sha;

    if (headIsMissing) {
      return commits.concat(headToAssert);
    } else if (headIsNotMissing) {
      return commits;
    }

    throw Error('Editorial workflow branch changed unexpectedly.');
  }

  updateUnpublishedEntryStatus(collection, slug, status) {
    const contentKey = slug;
    return this.retrieveMetadata(contentKey)
      .then(metadata => ({
        ...metadata,
        status,
      }))
      .then(updatedMetadata => this.storeMetadata(contentKey, updatedMetadata));
  }

  deleteUnpublishedEntry(collection, slug) {
    const contentKey = slug;
    const branchName = this.generateBranchName(contentKey);
    return (
      this.retrieveMetadata(contentKey)
        .then(metadata => this.closePR(metadata.pr))
        .then(() => this.deleteBranch(branchName))
        // If the PR doesn't exist, then this has already been deleted -
        // deletion should be idempotent, so we can consider this a
        // success.
        .catch(err => {
          if (err.message === 'Reference does not exist') {
            return Promise.resolve();
          }
          return Promise.reject(err);
        })
    );
  }

  publishUnpublishedEntry(collection, slug) {
    const contentKey = slug;
    const branchName = this.generateBranchName(contentKey);
    return this.retrieveMetadata(contentKey)
      .then(metadata => this.mergePR(metadata.pr, metadata.objects))
      .then(() => this.deleteBranch(branchName));
  }

  createRef(type, name, sha) {
    return this.request(`${this.repoURL}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/${type}/${name}`, sha }),
    });
  }

  patchRef(type, name, sha, opts = {}) {
    const force = opts.force || false;
    return this.request(`${this.repoURL}/git/refs/${type}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha, force }),
    });
  }

  deleteRef(type, name) {
    return this.request(`${this.repoURL}/git/refs/${type}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  }

  getBranch(branch: string = this.branch) {
    return this.request(`${this.repoURL}/branches/${encodeURIComponent(branch)}`);
  }

  createBranch(branchName: string, sha: string) {
    return this.createRef('heads', branchName, sha);
  }

  assertCmsBranch(branchName: string) {
    return branchName.startsWith(CMS_BRANCH_PREFIX);
  }

  patchBranch(branchName, sha, opts = {}) {
    const force = opts.force || false;
    if (force && !this.assertCmsBranch(branchName)) {
      throw Error(`Only CMS branches can be force updated, cannot force update ${branchName}`);
    }
    return this.patchRef('heads', branchName, sha, { force });
  }

  deleteBranch(branchName: string) {
    return this.deleteRef('heads', branchName);
  }

  createPR(title, head, base = this.branch) {
    const body = 'Automatically generated by Netlify CMS';
    return this.request(`${this.repoURL}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title, body, head, base }),
    });
  }

  closePR(pullrequest) {
    const prNumber = pullrequest.number;
    console.log('%c Deleting PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.request(`${this.repoURL}/pulls/${prNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({
        state: closed,
      }),
    });
  }

  mergePR(pullrequest, objects) {
    const headSha = pullrequest.head;
    const prNumber = pullrequest.number;
    console.log('%c Merging PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.request(`${this.repoURL}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      body: JSON.stringify({
        commit_message: 'Automatically generated. Merged on Netlify CMS.',
        sha: headSha,
        merge_method: this.mergeMethod,
      }),
    }).catch(error => {
      if (error instanceof APIError && error.status === 405) {
        return this.forceMergePR(pullrequest, objects);
      } else {
        throw error;
      }
    });
  }

  forceMergePR(pullrequest, objects) {
    const files = objects.files.concat(objects.entry);
    const fileTree = this.composeFileTree(files);
    let commitMessage = 'Automatically generated. Merged on Netlify CMS\n\nForce merge of:';
    files.forEach(file => {
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

  getTree(sha) {
    if (sha) {
      return this.request(`${this.repoURL}/git/trees/${sha}`);
    }
    return Promise.resolve({ tree: [] });
  }

  /**
   * Get a blob from a tree. Requests individual subtrees recursively if blob is
   * nested within one or more directories.
   */
  getBlobInTree(treeSha, pathToBlob) {
    const pathSegments = pathToBlob.split('/').filter(val => val);
    const directories = pathSegments.slice(0, -1);
    const filename = pathSegments.slice(-1)[0];
    const baseTree = this.getTree(treeSha);
    const subTreePromise = directories.reduce((treePromise, segment) => {
      return treePromise.then(tree => {
        const subTreeSha = find(tree.tree, { path: segment }).sha;
        return this.getTree(subTreeSha);
      });
    }, baseTree);
    return subTreePromise.then(subTree => find(subTree.tree, { path: filename }));
  }

  toBase64(str: string) {
    return Promise.resolve(Base64.encode(str));
  }

  uploadBlob(item) {
    const content = result(item, 'toBase64', partial(this.toBase64, item.raw));

    return content.then(contentBase64 =>
      this.request(`${this.repoURL}/git/blobs`, {
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

  updateTree(sha: string, path: string, fileTree: any) {
    return this.getTree(sha).then(tree => {
      let obj;
      let filename;
      let fileOrDir;
      const updates = [];
      const added = {};

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

  createTree(baseSha, tree) {
    return this.request(`${this.repoURL}/git/trees`, {
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

  commit(message, changeTree) {
    const parents = changeTree.parentSha ? [changeTree.parentSha] : [];
    return this.createCommit(message, changeTree.sha, parents);
  }

  createCommit(message, treeSha, parents, author, committer) {
    return this.request(`${this.repoURL}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: treeSha, parents, author, committer }),
    });
  }

  // In Azure we don't always have the SHA resp ID handy
  // this function is to get the ObjectId and CommitId (output)
  // from path and branch (input)
  getAzureId(path: string, branch: string = this.branch ) {
    return this.request(`${this.repoURL}/items`, {
      params: { version: this.branch, path: path,
        '$format': "json", versionType: "Branch", versionOptions: "None" } // Azure hardwired to get expected response format   
    });
  }
}
