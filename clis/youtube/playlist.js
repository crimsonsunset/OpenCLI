/**
 * YouTube playlist — navigate to /playlist?list= and read ytInitialData.
 * Homepage InnerTube browse (`VL` + id) returns no playlistVideoListRenderer
 * and used to throw EMPTY_RESULT for every list, including public ones.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { FETCH_BROWSE_FN, extractPlaylistVideos } from './utils.js';
import { CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

/**
 * Parse a playlist ID from a URL or bare ID string.
 */
function parsePlaylistId(input) {
    if (!input.startsWith('http'))
        return input;
    try {
        const url = new URL(input);
        return url.searchParams.get('list') || input;
    }
    catch {
        return input;
    }
}

cli({
    site: 'youtube',
    name: 'playlist',
    access: 'read',
    description: 'Get YouTube playlist info and video list',
    domain: 'www.youtube.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'id', required: true, positional: true, help: 'Playlist URL or playlist ID (PLxxxxxx)' },
        { name: 'limit', type: 'int', default: 50, help: 'Max videos to return (default 50, max 200)' },
    ],
    columns: ['rank', 'title', 'channel', 'duration', 'views', 'published', 'url'],
    func: async (page, kwargs) => {
        const playlistId = parsePlaylistId(String(kwargs.id));
        const limit = Math.min(kwargs.limit || 50, 200);
        await page.goto(`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`);
        await page.wait(3);
        const data = await page.evaluate(`
      (async () => {
        const d = window.ytInitialData;
        if (!d) return { error: 'YouTube data not found — are you logged in?' };

        const limit = ${limit};
        const cfg = window.ytcfg?.data_ || {};
        const apiKey = cfg.INNERTUBE_API_KEY;
        const context = cfg.INNERTUBE_CONTEXT;

        const pageHeader = d.header?.pageHeaderRenderer;
        const playlistHeader = d.header?.playlistHeaderRenderer;
        const title = pageHeader?.pageTitle
          || playlistHeader?.title?.simpleText
          || '';
        const metaRows = pageHeader?.content?.pageHeaderViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
        const stats = metaRows.length
          ? metaRows.flatMap(r => (r.metadataParts || []).map(p => p.text?.content || '').filter(Boolean))
          : (playlistHeader?.stats || [])
            .map(s => s.runs?.map(r => r.text)?.join('') || s.simpleText || '')
            .filter(Boolean);

        const sidebarItems = d.sidebar?.playlistSidebarRenderer?.items || [];
        const secondaryInfo = sidebarItems.find(i => i.playlistSidebarSecondaryInfoRenderer)?.playlistSidebarSecondaryInfoRenderer;
        const channelName = secondaryInfo?.videoOwner?.videoOwnerRenderer?.title?.runs?.[0]?.text || '';

        const tabs = d.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
        const tab = tabs.find(item => item.tabRenderer?.selected)?.tabRenderer || tabs[0]?.tabRenderer;
        const sections = tab?.content?.sectionListRenderer?.contents || [];
        let listContents = sections.flatMap(section => (section.itemSectionRenderer?.contents || [])
          .flatMap(item => item.playlistVideoListRenderer?.contents || item.richGridRenderer?.contents || [item]));

        ${FETCH_BROWSE_FN}

        const extractVideos = ${extractPlaylistVideos.toString()};
        const nextToken = items => {
          for (let i = items.length - 1; i >= 0; i--) {
            const token = items[i].continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
              || items[i].continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token;
            if (token) return token;
          }
          return null;
        };
        let videos = extractVideos(listContents);
        const seenTokens = new Set();
        let token = nextToken(listContents);
        let stalledPages = 0;
        while (videos.length < limit && token && apiKey && context) {
          if (seenTokens.has(token)) return { error: 'YouTube playlist repeated a continuation token' };
          if (seenTokens.size >= limit + 2) return { error: 'YouTube playlist continuation budget exhausted' };
          seenTokens.add(token);
          const contData = await fetchBrowse(apiKey, { context, continuation: token });
          if (contData.error) return contData;
          const newItems = contData.onResponseReceivedActions?.flatMap(action => action.appendContinuationItemsAction?.continuationItems || []) || [];
          if (!newItems.length) break;
          const nextVideos = extractVideos(newItems, videos.length);
          videos = videos.concat(nextVideos);
          token = nextToken(newItems);
          stalledPages = nextVideos.length ? 0 : stalledPages + 1;
          if (token && stalledPages >= 2) return { error: 'YouTube playlist continuation made no progress' };
        }

        return { title, channelName, stats, videos: videos.slice(0, limit) };
      })()
    `);
        if (!data || typeof data !== 'object') {
            throw new CommandExecutionError('Failed to fetch playlist data');
        }
        if (data.error) {
            throw new CommandExecutionError(String(data.error));
        }
        if (!data.videos?.length) {
            // Empty lists (test, book) are valid. Don't throw EMPTY_RESULT
            // or karakeep-sync treats them as a connector failure.
            if (data.title) {
                process.stderr.write(`${data.title}  [${data.channelName}]  0 videos\n`);
                return [];
            }
            throw new EmptyResultError('youtube playlist');
        }
        const statsStr = (data.stats || []).join(' | ');
        process.stderr.write(`${data.title}  [${data.channelName}]  ${statsStr}\n`);
        return data.videos;
    },
});
