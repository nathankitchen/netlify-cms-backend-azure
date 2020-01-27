import trimStart from 'lodash/trimStart';
import semaphore, { Semaphore } from 'semaphore';
import { trim } from 'lodash';
import { stripIndent } from 'common-tags';
import AuthenticationPage from './AuthenticationPage';
import API from './API';
import {
  Credentials,
  Implementation,
  ImplementationFile,
  DisplayURL,
  basename,
  Entry,
  AssetProxy,
  PersistOptions,
  getMediaDisplayURL,
  getMediaAsBlob,
  Config,
  getPreviewStatus,
  asyncLock,
  AsyncLock,
  runWithLock,
  User
} from 'netlify-cms-lib-util';
import { getBlobSHA } from 'netlify-cms-lib-util/src';

const MAX_CONCURRENT_DOWNLOADS = 10;

/**
 * Keywords for inferring a status that will provide a deploy preview URL.
 */
const PREVIEW_CONTEXT_KEYWORDS = ['deploy'];

class AzureRepo {
  org: string;
  project: string;
  name: string;

  constructor(location?: string | null)
  {
    if (!location || location == undefined) {
      throw new Error("An Azure repository must be specified in the format 'organisation/project/repo'.");
    }

    var components = location.split('/', 3);
    this.org = components[0];
    this.project = components[1];
    this.name = components[2] || components[1];
  }
}

/**
 * Check a given status context string to determine if it provides a link to a
 * deploy preview. Checks for an exact match against `previewContext` if given,
 * otherwise checks for inclusion of a value from `PREVIEW_CONTEXT_KEYWORDS`.

function isPreviewContext(context, previewContext) {
  if (previewContext) {
    return context === previewContext;
  }
  return PREVIEW_CONTEXT_KEYWORDS.some(keyword => context.includes(keyword));
}
 */

/**
 * Retrieve a deploy preview URL from an array of statuses. By default, a
 * matching status is inferred via `isPreviewContext`.
 *
 function getPreviewStatus(statuses, config) {
  const previewContext = config.getIn(['backend', 'preview_context']);
  return statuses.find(({ context }) => {
    return isPreviewContext(context, previewContext);
  });
}
**/

export default class Azure implements Implementation {

  lock: AsyncLock;
  api: API | null;
  options: {
    proxied: boolean;
    API: API | null;
    initialWorkflowStatus: string;
  };
  identityUrl: string;
  repo: AzureRepo;
  branch: string;
  apiRoot: string;
  token: string | null;
  squashMerges: boolean;
  mediaFolder: string;
  previewContext: string;

  _mediaDisplayURLSem?: Semaphore;

  constructor(config : Config, options = {}) {
    this.options = {
      proxied: false,
      API: null,
      initialWorkflowStatus: '',
      ...options,
    };

    if (!this.options.proxied) {

      if (config.backend.repo === null || config.backend.repo === undefined)
      {
        throw new Error('The Azure backend needs a "repo" in the backend configuration.');
      }
    }

    this.api = this.options.API || null;

    this.repo = new AzureRepo(config.backend.repo);
    this.branch = config.backend.branch || 'master';
    this.identityUrl = config.backend.identity_url || '';
    this.apiRoot = config.backend.api_root || 'https://dev.azure.com';
    this.token = '';
    this.squashMerges = config.backend.squash_merges || false;
    this.mediaFolder = config.media_folder;
    this.previewContext = config.backend.preview_context || '';
    this.lock = asyncLock();
  }

  authComponent() {
    return AuthenticationPage;
  }

  restoreUser(user: User) {
    return this.authenticate(user);
  }

  async authenticate(state: Credentials) {
    this.token = state.token as string;
    this.api = new API({
      token: this.token,
      branch: this.branch,
      org: this.repo.org,
      project: this.repo.project,
      repo: this.repo.name,
      api_root: this.apiRoot,
      squash_merges: this.squashMerges,
      initialWorkflowStatus: this.options.initialWorkflowStatus,
    });

    // TODO: get the user name/email address
    return { name: 'unspecified', token: state.token as string };
  }

  logout() {
    this.token = null;
    return;
  }

  getToken() {
    return Promise.resolve(this.token);
  }

  entriesByFolder(collection: string, extension: string, depth: number) {
    return this.api!
      .listFiles(collection)
      .then(files => { // Azure - de-activate filter for debug
        // files.filter(file => file.name.endsWith('.' + extension)))
        console.log('IMPL files-liste: ' + JSON.stringify (files ) );
        return files;
      })
    .then(this.fetchFiles);
  }

  entriesByFiles(files: ImplementationFile[]) {
    const listFiles = files.map((collectionFile : any)=> ({
      path: collectionFile.get('file'),
      label: collectionFile.get('label'),
    }));
    return this.fetchFiles(listFiles);
  }

  fetchFiles = (files: any)=> {
    const sem = semaphore(MAX_CONCURRENT_DOWNLOADS);
    const promises : any[] = [];
    files.forEach((file: any) => {
      console.log('** DEBUG fetchFiles ... file.url: ' + file.url );
      file.sha = file.objectId; // due to different element naming in Azure
      file.path = file.relativePath;
      promises.push(
        new Promise(resolve =>
          sem.take(() =>
            this.api!
              .readFile(file.url, file.objectId) // Azure
              .then(data => {
                resolve({ file, data });
                sem.leave();
              })
              .catch((err = true) => {
                sem.leave();
                console.error(`failed to load file from Azure: ${file.path}`);
                resolve({ error: err });
              }),
          ),
        ),
      );
    });
    return Promise.all(promises).then(loadedEntries =>
      loadedEntries.filter(loadedEntry => !loadedEntry.error),
    );
  };

  // Fetches a single entry.
  getEntry(path: string) {
    return this.api!.readFile(path).then(data => ({
      file: { path },
      data,
    }));
  }

  getMedia() {
    return this.api!.listFiles(this.mediaFolder).then(files =>
      // files.map(({ sha, name, size, download_url, path }) => {
      files.map(({ objectId, relativePath, size, url }) => { // Azure
          const sha = objectId;
	      	const name = relativePath;
      		const path = 'no-path-here';
          const url2 = new URL(url);
        if (url2.pathname.match(/.svg$/)) {
          url2.search += (url2.search.slice(1) === '' ? '?' : '&') + 'sanitize=true';
        }
        return { id: sha, name, size, displayURL: url2.href, path };
      }),
    );
  }

  getMediaDisplayURL(displayURL: DisplayURL) {
    this._mediaDisplayURLSem = this._mediaDisplayURLSem || semaphore(MAX_CONCURRENT_DOWNLOADS);
    return getMediaDisplayURL(
      displayURL,
      this.api!.readFile.bind(this.api!),
      this._mediaDisplayURLSem,
    );
  }

  async getMediaFile(path: string) {
    const name = basename(path);
    const blob = await getMediaAsBlob(path, null, this.api!.readFile.bind(this.api!));
    const fileObj = new File([blob], name);
    const url = URL.createObjectURL(fileObj);
    const id = await getBlobSHA(blob);

    return {
      id,
      displayURL: url,
      path,
      name,
      size: fileObj.size,
      file: fileObj,
      url,
    };
  }

  persistEntry(entry: Entry, mediaFiles: AssetProxy[], options: PersistOptions) {
    return this.api!.persistFiles(entry, mediaFiles, options);
  }

  async persistMedia(mediaFile: AssetProxy, options: PersistOptions) {


    const fileObj = mediaFile.fileObj as File;

    const [id] = await Promise.all([
      getBlobSHA(fileObj),
      this.api!.persistFiles(null, [mediaFile], options),
    ]);

    const { path } = mediaFile;
    const url = URL.createObjectURL(fileObj);

    return {
      displayURL: url,
      path: trimStart(path, '/'),
      name: fileObj!.name,
      size: fileObj!.size,
      file: fileObj,
      url,
      id,
    };
  }

  deleteFile(path: string, commitMessage: string) {
    return this.api!.deleteFile(path, commitMessage);
  }

  unpublishedEntries() {
    return this.api!
      .listUnpublishedBranches()
      .then(branches => {
        const sem = semaphore(MAX_CONCURRENT_DOWNLOADS);
        const promises : any[] = [];
        branches.map((branch: any) => {
          promises.push(
            new Promise(resolve => {
              const slug = branch.ref.split('refs/heads/cms/').pop();
              return sem.take(() =>
                this.api!
                  .readUnpublishedBranchFile(slug)
                  .then((data: any) => {
                    if (data === null || data === undefined) {
                      resolve(null);
                      sem.leave();
                    } else {
                      const path = data.metaData.objects.entry.path;
                      resolve({
                        slug,
                        file: { path },
                        data: data.fileData,
                        metaData: data.metaData,
                        isModification: data.isModification,
                      });
                      sem.leave();
                    }
                  })
                  .catch(() => {
                    sem.leave();
                    resolve(null);
                  }),
              );
            }),
          );
        });
        return Promise.all(promises);
      })
      .catch(error => {
        if (error.message === 'Not Found') {
          return Promise.resolve([]);
        }
        return error;
      });
  }

  unpublishedEntry(collection: string, slug: string) {
    return this.api!.readUnpublishedBranchFile(slug).then((data: any) => {
      if (!data) return null;
      return {
        slug,
        file: { path: data.metaData.objects.entry.path },
        data: data.fileData,
        metaData: data.metaData,
        isModification: data.isModification,
      };
    });
  }

  updateUnpublishedEntryStatus(collection: string, slug: string, newStatus: string) {
    // updateUnpublishedEntryStatus is a transactional operation
    return runWithLock(
      this.lock,
      () => this.api!.updateUnpublishedEntryStatus(collection, slug, newStatus),
      'Failed to acquire update entry status lock',
    );
  }

  deleteUnpublishedEntry(collection: string, slug: string) {
    // deleteUnpublishedEntry is a transactional operation
    return runWithLock(
      this.lock,
      () => this.api!.deleteUnpublishedEntry(collection, slug),
      'Failed to acquire delete entry lock',
    );
  }
  publishUnpublishedEntry(collection: string, slug: string) {
    // publishUnpublishedEntry is a transactional operation
    return runWithLock(
      this.lock,
      () => this.api!.publishUnpublishedEntry(collection, slug),
      'Failed to acquire publish entry lock',
    );
  }

    /**
   * Uses Azure's Statuses API to retrieve statuses, infers which is for a
   * deploy preview via `getPreviewStatus`. Returns the url provided by the
   * status, as well as the status state, which should be one of 'success',
   * 'pending', and 'failure'.
   */
  async getDeployPreview(collection: string, slug: string) {
    try {
      const data = await this.api!.retrieveMetadata(slug);

      if (!data) {
        return null;
      }

      const statuses = await this.api!.getStatuses(data.pr.head);
      const deployStatus = getPreviewStatus(statuses, this.previewContext);

      if (deployStatus) {
        const { target_url: url, state } = deployStatus;
        return { url, status: state };
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }
  }
}
