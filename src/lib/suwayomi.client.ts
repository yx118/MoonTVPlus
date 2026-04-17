/* eslint-disable @typescript-eslint/no-explicit-any */

import { getConfig } from './config';
import {
  MangaChapter,
  MangaDetail,
  MangaRecommendResult,
  MangaRecommendType,
  MangaSearchItem,
  MangaSource,
} from './manga.types';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface SuwayomiClientOptions {
  serverUrl?: string;
  token?: string;
}

interface ResolvedSuwayomiConfig {
  serverBaseUrl: string;
  serverUrl: string;
  token?: string;
  defaultLang: string;
  sourceIds: string[];
  maxSources: number;
}

async function resolveSuwayomiConfig(options: SuwayomiClientOptions = {}): Promise<ResolvedSuwayomiConfig> {
  let serverUrl = options.serverUrl || process.env.SUWAYOMI_URL || process.env.NEXT_PUBLIC_SUWAYOMI_URL || '';
  let token = options.token || process.env.SUWAYOMI_AUTH_TOKEN || '';
  let defaultLang = process.env.SUWAYOMI_DEFAULT_LANG || 'zh';
  let sourceIds: string[] = [];
  let maxSources = Number(process.env.SUWAYOMI_MAX_SOURCES || 10);

  try {
    const config = await getConfig();
    if (config.SuwayomiConfig?.Enabled) {
      serverUrl = config.SuwayomiConfig.ServerURL || serverUrl;
      token = config.SuwayomiConfig.AuthToken || token;
      defaultLang = config.SuwayomiConfig.DefaultLang || defaultLang;
      sourceIds = config.SuwayomiConfig.SourceIds || sourceIds;
      maxSources = config.SuwayomiConfig.MaxSources || maxSources;
    }
  } catch {
    // 配置读取失败时回退到环境变量
  }

  if (!serverUrl) {
    throw new Error('Suwayomi 未配置，请先在管理面板或环境变量中设置服务地址');
  }

  const normalizedBaseUrl = serverUrl.replace(/\/$/, '');

  return {
    serverBaseUrl: normalizedBaseUrl,
    serverUrl: normalizedBaseUrl + '/api/graphql',
    token: token || undefined,
    defaultLang,
    sourceIds,
    maxSources,
  };
}

export async function getSuwayomiConfig(options: SuwayomiClientOptions = {}): Promise<ResolvedSuwayomiConfig> {
  return resolveSuwayomiConfig(options);
}

export function buildSuwayomiImageProxyUrl(pathOrUrl: string): string {
  if (!pathOrUrl) return '';
  if (pathOrUrl.startsWith('/api/manga/image?')) return pathOrUrl;
  return `/api/manga/image?path=${encodeURIComponent(pathOrUrl)}`;
}

export class SuwayomiClient {
  private options: SuwayomiClientOptions;

  constructor(options: SuwayomiClientOptions = {}) {
    this.options = options;
  }

  private async graphqlRequest<T>(query: string, variables?: Record<string, any>, operationName?: string): Promise<T> {
    const resolved = await resolveSuwayomiConfig(this.options);
    const response = await fetch(resolved.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(resolved.token ? { Authorization: `Bearer ${resolved.token}` } : {}),
      },
      body: JSON.stringify({ query, variables, operationName }),
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Suwayomi 请求失败: ${response.status}`);
    }

    const data = (await response.json()) as GraphQLResponse<T>;
    if (data.errors?.length) {
      throw new Error(data.errors.map((item) => item.message || 'Unknown error').join('; '));
    }
    if (!data.data) {
      throw new Error('Suwayomi 返回空数据');
    }
    return data.data;
  }

  async getSources(lang?: string): Promise<MangaSource[]> {
    const resolved = await resolveSuwayomiConfig(this.options);
    const query = `
      query GetSources {
        sources {
          nodes {
            id
            name
            lang
            displayName
          }
        }
      }
    `;

    const data = await this.graphqlRequest<{
      sources?: { nodes?: Array<{ id: string; name?: string; lang?: string; displayName?: string }> };
    }>(query);

    const nodes = data.sources?.nodes || [];
    const filtered = nodes.filter((item) => !lang || item.lang === lang);
    const scoped = resolved.sourceIds.length > 0
      ? filtered.filter((item) => resolved.sourceIds.includes(String(item.id)))
      : filtered;

    return scoped.map((item) => ({
      id: String(item.id),
      name: item.name || item.displayName || String(item.id),
      lang: item.lang,
      displayName: item.displayName,
    }));
  }

  async searchManga(keyword: string, sourceId?: string, page = 1): Promise<MangaSearchItem[]> {
    const resolved = await resolveSuwayomiConfig(this.options);
    const sources = sourceId
      ? [{ id: sourceId, displayName: sourceId, name: sourceId }]
      : (await this.getSources(resolved.defaultLang)).slice(0, resolved.maxSources);
    const query = `
      mutation GET_SOURCE_MANGAS_FETCH($input: FetchSourceMangaInput!) {
        fetchSourceManga(input: $input) {
          mangas {
            id
            title
            thumbnailUrl
            sourceId
            description
            author
            artist
            genre
            status
          }
        }
      }
    `;

    const results: MangaSearchItem[] = [];
    const seen = new Set<string>();

    for (const source of sources) {
      const data = await this.graphqlRequest<{
        fetchSourceManga?: {
          mangas?: Array<{
            id: string | number;
            title?: string;
            thumbnailUrl?: string;
            sourceId?: string | number;
            description?: string;
            author?: string;
            artist?: string;
            genre?: string;
            status?: string;
          }>;
        };
      }>(
        query,
        {
          input: {
            type: 'SEARCH',
            source: source.id,
            query: keyword,
            page,
          },
        },
        'GET_SOURCE_MANGAS_FETCH'
      ).catch(() => ({ fetchSourceManga: { mangas: [] } }));

      const mangas = data.fetchSourceManga?.mangas || [];
      for (const manga of mangas) {
        const key = `${source.id}:${manga.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          id: String(manga.id),
          sourceId: String(manga.sourceId || source.id),
          sourceName: source.displayName || source.name || String(source.id),
          title: manga.title || '未命名漫画',
          cover: buildSuwayomiImageProxyUrl(manga.thumbnailUrl || ''),
          description: manga.description,
          author: manga.author,
          artist: manga.artist,
          genre: manga.genre,
          status: manga.status,
        });
      }
    }

    return results;
  }

  async getRecommendedManga(
    sourceId: string,
    type: MangaRecommendType = 'POPULAR',
    page = 1
  ): Promise<MangaRecommendResult> {
    if (!sourceId) {
      return { mangas: [], hasNextPage: false };
    }

    const query = `
      fragment MANGA_BASE_FIELDS on MangaType {
        id
        title
        thumbnailUrl
        sourceId
        description
        author
        artist
        genre
        status
      }

      mutation GET_SOURCE_MANGAS_FETCH($input: FetchSourceMangaInput!) {
        fetchSourceManga(input: $input) {
          hasNextPage
          mangas {
            ...MANGA_BASE_FIELDS
          }
        }
      }
    `;

    const sources = await this.getSources();
    const matchedSource = sources.find((item) => item.id === sourceId);

    const data = await this.graphqlRequest<{
      fetchSourceManga?: {
        hasNextPage?: boolean;
        mangas?: Array<{
          id: string | number;
          title?: string;
          thumbnailUrl?: string;
          sourceId?: string | number;
          description?: string;
          author?: string;
          artist?: string;
          genre?: string;
          status?: string;
        }>;
      };
    }>(
      query,
      {
        input: {
          type,
          source: sourceId,
          page,
        },
      },
      'GET_SOURCE_MANGAS_FETCH'
    );

    return {
      hasNextPage: Boolean(data.fetchSourceManga?.hasNextPage),
      mangas: (data.fetchSourceManga?.mangas || []).map((manga) => ({
        id: String(manga.id),
        sourceId: String(manga.sourceId || sourceId),
        sourceName: matchedSource?.displayName || matchedSource?.name || sourceId,
        title: manga.title || '未命名漫画',
        cover: buildSuwayomiImageProxyUrl(manga.thumbnailUrl || ''),
        description: manga.description,
        author: manga.author,
        artist: manga.artist,
        genre: manga.genre,
        status: manga.status,
      })),
    };
  }

  async getChapters(mangaId: string): Promise<MangaChapter[]> {
    const mutation = `
      mutation GET_MANGA_CHAPTERS_FETCH($input: FetchChaptersInput!) {
        fetchChapters(input: $input) {
          chapters {
            id
            mangaId
            name
            chapterNumber
            scanlator
            isRead
            isDownloaded
            pageCount
            uploadDate
          }
        }
      }
    `;

    const data = await this.graphqlRequest<{
      fetchChapters?: {
        chapters?: Array<{
          id: string | number;
          mangaId?: string | number;
          name?: string;
          chapterNumber?: number;
          scanlator?: string;
          isRead?: boolean;
          isDownloaded?: boolean;
          pageCount?: number;
          uploadDate?: number;
        }>;
      };
    }>(mutation, { input: { mangaId: Number(mangaId) || mangaId } }, 'GET_MANGA_CHAPTERS_FETCH');

    return (data.fetchChapters?.chapters || []).map((chapter) => ({
      id: String(chapter.id),
      mangaId: String(chapter.mangaId || mangaId),
      name: chapter.name || '未命名章节',
      chapterNumber: chapter.chapterNumber,
      scanlator: chapter.scanlator,
      isRead: chapter.isRead,
      isDownloaded: chapter.isDownloaded,
      pageCount: chapter.pageCount,
      uploadDate: chapter.uploadDate,
    }));
  }

  async getMangaDetail(input: {
    mangaId: string;
    sourceId: string;
    title?: string;
    cover?: string;
    sourceName?: string;
    description?: string;
    author?: string;
    status?: string;
  }): Promise<MangaDetail> {
    const chapters = await this.getChapters(input.mangaId);

    let metadata: Partial<MangaSearchItem> = {
      id: input.mangaId,
      sourceId: input.sourceId,
      sourceName: input.sourceName || input.sourceId,
      title: input.title || '漫画详情',
      cover: input.cover || '',
      description: input.description,
      author: input.author,
      status: input.status,
    };

    const detailQuery = `
      query MangaDetail($id: LongString!) {
        manga(id: $id) {
          id
          title
          thumbnailUrl
          sourceId
          description
          author
          artist
          genre
          status
        }
      }
    `;

    try {
      const detailData = await this.graphqlRequest<{
        manga?: {
          id: string | number;
          title?: string;
          thumbnailUrl?: string;
          sourceId?: string | number;
          description?: string;
          author?: string;
          artist?: string;
          genre?: string;
          status?: string;
        };
      }>(detailQuery, { id: input.mangaId }, 'MangaDetail');

      if (detailData.manga) {
        metadata = {
          id: String(detailData.manga.id),
          sourceId: String(detailData.manga.sourceId || input.sourceId),
          sourceName: input.sourceName || input.sourceId,
          title: detailData.manga.title || metadata.title || '漫画详情',
          cover: buildSuwayomiImageProxyUrl(detailData.manga.thumbnailUrl || metadata.cover || ''),
          description: detailData.manga.description || metadata.description,
          author: detailData.manga.author || metadata.author,
          artist: detailData.manga.artist,
          genre: detailData.manga.genre,
          status: detailData.manga.status || metadata.status,
        };
      }
    } catch {
      // 某些 Suwayomi 版本不支持直接 manga(id) 查询，降级为外部参数 + 章节信息
    }

    return {
      id: metadata.id || input.mangaId,
      sourceId: metadata.sourceId || input.sourceId,
      sourceName: metadata.sourceName || input.sourceId,
      title: metadata.title || '漫画详情',
      cover: buildSuwayomiImageProxyUrl(metadata.cover || ''),
      description: metadata.description,
      author: metadata.author,
      artist: metadata.artist,
      genre: metadata.genre,
      status: metadata.status,
      chapters,
    };
  }

  async getChapterPages(chapterId: string): Promise<string[]> {
    const mutation = `
      mutation GET_CHAPTER_PAGES_FETCH($input: FetchChapterPagesInput!) {
        fetchChapterPages(input: $input) {
          pages
        }
      }
    `;

    const data = await this.graphqlRequest<{
      fetchChapterPages?: { pages?: string[] };
    }>(mutation, { input: { chapterId: Number(chapterId) || chapterId } }, 'GET_CHAPTER_PAGES_FETCH');

    return (data.fetchChapterPages?.pages || []).map((item) => buildSuwayomiImageProxyUrl(item));
  }
}

export const suwayomiClient = new SuwayomiClient();
