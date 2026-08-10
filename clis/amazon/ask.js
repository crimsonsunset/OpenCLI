import { CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  assertUsableState,
  buildProductUrl,
  buildProvenance,
  cleanText,
  extractAsin,
  gotoAndReadState,
  normalizeProductUrl,
  uniqueNonEmpty,
} from './shared.js';

const PRODUCT_TITLE_SELECTOR = '#productTitle, #title span, [data-feature-name="title"] h1 span';

/**
 * Normalize Nile Ask payload for CLI output.
 * @param {Record<string, unknown>} payload - Raw page payload
 * @param {string} input - Original ASIN/URL input
 */
function normalizeAskPayload(payload, input) {
  const sourceUrl = cleanText(payload.href) || buildProductUrl(input);
  const asin = extractAsin(payload.href ?? '') ?? extractAsin(input) ?? null;
  const provenance = buildProvenance(sourceUrl);
  return {
    asin,
    product_url: normalizeProductUrl(sourceUrl) || (asin ? buildProductUrl(asin) : null),
    ...provenance,
    widget: 'nile-ask',
    question: cleanText(payload.question) || null,
    answer: cleanText(payload.answer) || null,
    suggested_questions: uniqueNonEmpty(payload.suggested_questions ?? []),
  };
}

/**
 * Drive the product-page Nile Ask widget (Looking for specific info? / Ask Alexa).
 * @param {import('@jackwener/opencli/types').Page} page - Browser page
 * @param {string} question - Question to submit, or empty to only list suggestions
 * @param {number} timeoutMs - Max wait for streamed answer
 */
async function runNileAsk(page, question, timeoutMs) {
  return await page.evaluate(`
    (async () => {
      const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const getAskInput = () => document.querySelector('#dpx-rex-nile-search-text-input');

      const waitForAskWidget = async (maxMs) => {
        const started = Date.now();
        while (Date.now() - started < maxMs) {
          const root = document.querySelector('#nile-inline_feature_div, #nile-inline-btf_feature_div') || getAskInput();
          root?.scrollIntoView?.({ block: 'center' });
          if (getAskInput()) return true;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return Boolean(getAskInput());
      };

      const collectSuggestedQuestions = () => {
        const selectors = [
          '#dpx-rex-nile-inline-default-pills-container .dpx-rex-nile-inline-pill-button .a-button-text',
          '#dpx-rex-nile-inline-default-pills-container button.rufus-pill',
          '#nile-inline_feature_div button.rufus-pill',
          '#nile-inline-btf_feature_div button.rufus-pill',
        ];
        const seen = new Set();
        const out = [];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const text = clean(el.textContent);
            if (!text || seen.has(text)) return;
            seen.add(text);
            out.push(text);
          });
        }
        return out;
      };

      const clearPriorAnswer = async () => {
        const clearWrap = document.querySelector('#dpx-rex-nice-clear-button');
        const clearBtn = document.querySelector('#dpx-rex-nice-clear-button-announce');
        if (!clearBtn || clearWrap?.classList?.contains('dpx-rex-nile-inline-hidden')) return;
        clearBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 350));
      };

      const readAnswerText = () => {
        const textEl = document.querySelector('#dpx-rex-nile-inline-answer-text-container');
        const markdown = textEl?.querySelector('.rufus-dpx-markdown-content');
        return clean((markdown || textEl)?.innerText || textEl?.textContent || '');
      };

      const waitForAnswer = async (maxMs, stableMs) => {
        const started = Date.now();
        let lastLen = 0;
        let stableSince = Date.now();
        while (Date.now() - started < maxMs) {
          const errVisible = [
            '#dpx-rex-nile-inline-answer-text-container-error',
            '#dpx-rex-nile-inline-answer-generic-error',
          ].some((sel) => {
            const el = document.querySelector(sel);
            return el && !el.classList.contains('dpx-rex-nile-inline-hidden') && clean(el.innerText);
          });
          if (errVisible) return readAnswerText();

          const answer = readAnswerText();
          const loaderHidden = document
            .querySelector('#dpx-rex-nile-inline-loader-spinner')
            ?.classList?.contains('dpx-rex-nile-inline-hidden');
          const container = document.querySelector('#dpx-rex-nile-inline-answer-container');
          const containerVisible = container && !container.classList.contains('dpx-rex-nile-inline-hidden');

          if (answer.length !== lastLen) {
            lastLen = answer.length;
            stableSince = Date.now();
          }
          if (containerVisible && answer.length > 20 && loaderHidden && Date.now() - stableSince >= stableMs) {
            return answer;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return readAnswerText();
      };

      const ready = await waitForAskWidget(10000);
      if (!ready) {
        return {
          href: location.href,
          error: 'Looking for specific info? widget not found on this product page',
          suggested_questions: [],
        };
      }

      const suggested_questions = collectSuggestedQuestions();
      const questionText = ${JSON.stringify(question)};
      if (!questionText) {
        return {
          href: location.href,
          question: '',
          answer: '',
          suggested_questions,
        };
      }

      const input = getAskInput();
      const submit = document.querySelector('#dpx-rex-nile-submit-button-announce');
      if (!input || !submit) {
        return {
          href: location.href,
          error: 'Nile Ask controls not found',
          suggested_questions,
        };
      }

      await clearPriorAnswer();
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.value = questionText;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      submit.click();

      const answer = await waitForAnswer(${Number(timeoutMs)}, 1500);
      return {
        href: location.href,
        question: questionText,
        answer,
        suggested_questions,
      };
    })()
  `);
}

/**
 * Navigate to the product page and run Nile Ask.
 * @param {import('@jackwener/opencli/types').Page} page - Browser page
 * @param {string} input - ASIN or product URL
 * @param {string} question - Optional question text
 * @param {number} timeoutMs - Answer wait deadline
 */
async function readAskPayload(page, input, question, timeoutMs) {
  const url = buildProductUrl(input);
  const state = await gotoAndReadState(page, url, 2500, 'ask');
  assertUsableState(state, 'ask');
  await page.wait({ selector: PRODUCT_TITLE_SELECTOR, timeout: 6 }).catch(() => { });
  return runNileAsk(page, question, timeoutMs);
}

cli({
  site: 'amazon',
  name: 'ask',
  access: 'read',
  description:
    'Ask the product-page Looking for specific info? / Ask Alexa widget (Nile): suggested questions and streamed answers from reviews + Q&A',
  domain: 'amazon.com',
  strategy: Strategy.COOKIE,
  navigateBefore: false,
  args: [
    {
      name: 'input',
      required: true,
      positional: true,
      help: 'ASIN or product URL, for example B0G1SKBNJM',
    },
    {
      name: 'question',
      required: false,
      positional: true,
      help: 'Question to submit (omit to only list suggested questions)',
    },
    {
      name: 'timeoutMs',
      type: 'int',
      default: 25000,
      help: 'Max wait for streamed answer (default 25000)',
    },
  ],
  columns: ['asin', 'question', 'answer'],
  func: async (page, kwargs) => {
    const input = String(kwargs.input ?? '');
    const question = cleanText(kwargs.question) || '';
    const timeoutMs = Math.max(5000, Number(kwargs.timeoutMs) || 25000);
    const payload = await readAskPayload(page, input, question, timeoutMs);

    if (payload?.error) {
      throw new CommandExecutionError(
        `amazon ask: ${payload.error}`,
        'Open the product page in Chrome, confirm the Looking for specific info? box is visible, and retry.',
      );
    }

    const normalized = normalizeAskPayload(payload, input);
    if (question && !normalized.answer) {
      throw new CommandExecutionError(
        'amazon ask did not return an answer',
        'Retry the question, or try one of the suggested chips from `opencli amazon ask <asin>`.',
      );
    }
    if (!question && normalized.suggested_questions.length === 0) {
      throw new CommandExecutionError(
        'amazon ask did not expose suggested questions',
        'The Nile widget may be missing on this product or still loading. Open the /dp page and retry.',
      );
    }
    return [normalized];
  },
});

export const __test__ = {
  normalizeAskPayload,
};
