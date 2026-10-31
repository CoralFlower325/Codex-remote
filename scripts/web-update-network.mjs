import { EnvHttpProxyAgent, fetch as networkFetch } from 'undici';

// Honor an explicitly configured host proxy without changing global settings.
let dispatcher;
export const fetchRelease = (url, options) => networkFetch(url, {
  ...options, dispatcher: dispatcher ||= new EnvHttpProxyAgent()
});
