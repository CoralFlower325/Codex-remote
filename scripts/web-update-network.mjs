import { EnvHttpProxyAgent, fetch as networkFetch } from 'undici';
import { createReleaseFetch as boundedFetch } from '../desktop/release-network.mjs';

export function createReleaseFetch(options = {}) {
  return boundedFetch({ fetcher: networkFetch,
    createDispatcher: () => new EnvHttpProxyAgent(), ...options });
}

export const fetchRelease = createReleaseFetch();
