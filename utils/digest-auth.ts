import { createHash, randomBytes } from 'node:crypto';
import { traceDataApi } from '@/utils/data-api/endpoint';
import { UpstreamError } from '@/utils/data-api/error';

declare global {
  interface Response {
    dataApiTraceIds?: string[];
  }
}

type DigestConfig = {
  username: string
  password: string
}

type DigestRequest = {
  realm: string
  domain: string
  nonce: string
  algorithm: string
  qop: string
  stale: string
}

type DigestResponse = {
  username: string
  realm: string
  nonce: string
  uri: string
  qop: string
  nc: string
  cnonce: string
  response: string
}

function parseDigestRequest (response: Response): DigestRequest | null {
  const auth = response.headers.get('www-authenticate');

  if (!auth || !/^Digest\s/i.test(auth)) {
    return null;
  }

  return auth.replace(/^Digest\s/i, '')
    .split(',')
    .map(item => item.split('='))
    .reduce((obj, [k, v]) => {
      obj[k.trim()] = v.trim().replace(/^"|"$/g, '');
      return obj;
    }, {} as any);
}

function generateDigestResponse (method: string, url: URL, req: DigestRequest, config: DigestConfig, hash: (content: string) => string, getNonceCount: () => number): DigestResponse {
  const uri = url.pathname + url.search;

  const ha1 = hash(`${config.username}:${req.realm}:${config.password}`);
  const ha2 = hash(`${method}:${uri}`);

  const nc = String(getNonceCount()).padStart(8, '0');
  const cnonce = randomBytes(4).toString('hex');

  const response = hash(`${ha1}:${req.nonce}:${nc}:${cnonce}:${req.qop}:${ha2}`);

  return {
    username: config.username,
    realm: req.realm,
    nonce: req.nonce,
    uri,
    qop: req.qop,
    nc,
    cnonce,
    response,
  };
}

export function wrapFetchWithDigestFlow (nativeFetch: typeof fetch, config: DigestConfig): typeof fetch {
  let nc = 0;

  async function digestFetch (input: Request | URL | string, init?: RequestInit) {
    let response = await nativeFetch(input, init);
    let traceIds: string[] = [];

    traceDataApi(traceIds, response);
    const digestRequest = parseDigestRequest(response);

    // if (response.status === 401) {
    if (digestRequest) {
      if (response.status !== 401) {
        console.warn('Digest headers returned but status code is %s. URL = %s digest value: %o', response.status, urlStringOf(input), digestRequest);
        throw UpstreamError.ofHttp(urlStringOf(input), response, `Digest headers returned but status code is ${response.status}. [Url = ${urlStringOf(input)}] [TraceIds = ${response.dataApiTraceIds}] [Response Headers = ${stringifyHeaders(response.headers)}]`);
      }

      let method: string;
      let url: URL;

      if (typeof input === 'string') {
        method = init?.method ?? 'GET';
        url = new URL(input);
      } else if ('url' in input) {
        method = input.method ?? 'GET';
        url = new URL(input.url);
      } else {
        method = init?.method ?? 'GET';
        url = input;
      }

      let hash: (content: string) => string;

      switch (digestRequest.algorithm) {
        case 'MD5':
          hash = md5;
          break;
        default:
          throw new Error(`Unsupported algorithm '${digestRequest.algorithm}'`);
      }

      const digestResponse = generateDigestResponse(method, url, digestRequest, config, md5, () => ++nc);
      const credential = stringify(digestResponse);

      response = await nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          Authorization: credential,
        },
      });
      traceDataApi(traceIds, response);

      if (!response.ok) {
        console.warn('Authorization failed req:', digestRequest, 'res:', { ...digestResponse, username: '[[ERASED]]', response: '[[ERASED]]' }, 'traceIds:', traceIds);
      }
      // }
    }

    if (traceIds.length > 0) {
      response.dataApiTraceIds = traceIds;
    }
    return response;
  }

  return digestFetch;
}

function md5 (content: string) {
  return createHash('md5').update(content).digest('hex');
}

function stringify (res: DigestResponse) {
  return `Digest username="${res.username}", realm="${res.realm}", nonce="${res.nonce}", uri="${res.uri}", qop=${res.qop}, nc=${res.nc}, cnonce=${res.cnonce}, response=${res.response}`;
}

function urlStringOf (init: string | Request | URL): string {
  if (typeof init === 'object') {
    if ('url' in init) {
      return init.url.toString();
    } else {
      return init.toString();
    }
  } else {
    return init;
  }
}

function stringifyHeaders (headers: Headers) {
  const json: any = {};
  headers.forEach((value, key) => {
    json[key] = value
  });
  return JSON.stringify(json, undefined, 2)
}