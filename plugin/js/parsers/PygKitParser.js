"use strict";

// PYG-KIT parser
parserFactory.register("pyg-kit.com", () => new PygKitParser());

class PygKitParser extends Parser { // eslint-disable-line no-unused-vars

    constructor() {
        super();
        this.minimumThrottle = 750;
    }

    /**
     * PYG-KIT's book page does NOT contain the complete chapter list.
     * It currently exposes only a small selection such as:
     *   Chapter 1: Start Reading
     *   Chapter 2: ...1035...
     *   ...
     *
     * The First Chapter page, however, contains the complete chapter
     * link list. Therefore we always open First Chapter when starting
     * from the book page and collect the chapter links from there.
     */
    async getChapterUrls(dom, chapterUrlsUI) {

        const firstChapterLink = this.findFirstChapterLink(dom);

        if (firstChapterLink == null) {
            throw new Error(
                "Could not find the First Chapter link on PYG-KIT."
            );
        }

        /*
         * PYG-KIT does NOT put all 1039 links into one DOM.
         *
         * Each chapter page contains a moving local chapter window.
         * For example, Chapter 51 exposes links through roughly Chapter
         * 91, while the page also has:
         *
         *     All chapters (1039)
         *
         * The "All chapters" control returns to the book page; it is not
         * itself the complete chapter list.
         *
         * Therefore:
         *
         *   1. Load Chapter 1.
         *   2. Collect every /chapters/<id> link on that page.
         *   3. Find the highest internal chapter-page ID discovered.
         *   4. Jump directly to that chapter instead of crawling one
         *      chapter at a time.
         *   5. Repeat until no new chapter links are discovered.
         *
         * This reduces the crawl from ~1039 HTTP requests to roughly
         * a few dozen for a 40-50 chapter moving window.
         */

        let linksByUrl = new Map();
        let visitedPages = new Set();

        let pageUrl = firstChapterLink.href;

        const MAX_PAGES = 200;

        while (
            pageUrl != null &&
            !visitedPages.has(pageUrl) &&
            visitedPages.size < MAX_PAGES
        ) {

            visitedPages.add(pageUrl);

            const response = await HttpClient.wrapFetch(pageUrl);
            const pageDom = response.responseXML;

            if (pageDom == null) {
                throw new Error(
                    `Could not load PYG-KIT chapter page: ${pageUrl}`
                );
            }

            const beforeCount = linksByUrl.size;

            /*
             * Add every chapter link from this page.
             * Keep the actual <a> DOM element because
             * util.hyperLinkToChapter() requires it.
             */
            for (const link of this.findChapterLinks(pageDom)) {

                if (
                    link.href &&
                    !linksByUrl.has(link.href)
                ) {
                    linksByUrl.set(link.href, link);
                }
            }

            /*
             * If we already have the site's reported total, we are done.
             */
            const total = this.findTotalChapterCount(pageDom);

            if (
                total != null &&
                linksByUrl.size >= total
            ) {
                break;
            }

            /*
             * Jump to the highest chapter-page ID discovered so far.
             *
             * PYG-KIT's internal /chapters/<id> IDs are monotonic with
             * chapter order for this novel. This lets us skip directly
             * through the moving chapter windows.
             */
            let nextLink = null;
            let highestId = -1;

            for (const link of linksByUrl.values()) {

                const id = this.getChapterPageId(link.href);

                if (
                    id > highestId &&
                    !visitedPages.has(link.href)
                ) {
                    highestId = id;
                    nextLink = link;
                }
            }

            /*
             * No new page to visit means the chapter window stopped
             * advancing. Do not loop forever.
             */
            if (nextLink == null) {
                break;
            }

            /*
             * Safety check: if this request added nothing and the next
             * page is not actually beyond the current page, stop.
             */
            if (
                linksByUrl.size === beforeCount &&
                visitedPages.has(nextLink.href)
            ) {
                break;
            }

            pageUrl = nextLink.href;
        }

        let links = [...linksByUrl.values()];

        if (links.length === 0) {
            throw new Error(
                "Could not find any chapter links on PYG-KIT."
            );
        }

        /*
         * Final ordering:
         *
         * /chapters/<id> is an internal database/page ID rather than the
         * displayed chapter number, but the IDs are monotonic with the
         * chapter sequence for this novel.
         */
        links.sort((a, b) => {
            const aId = this.getChapterPageId(a.href);
            const bId = this.getChapterPageId(b.href);

            return aId - bId;
        });

        const chapterUrls = [];

        for (let index = 0; index < links.length; index++) {

            const link = links[index];

            // WebToEpub requires the real <a> element.
            const chapter = util.hyperLinkToChapter(link);

            const chapterNumber = index + 1;

            chapter.title = this.normalizeChapterTitle(
                link,
                chapterNumber
            );

            chapterUrls.push(chapter);
        }

        /*
         * Do not silently accept an obviously incomplete list when
         * PYG-KIT reports a total chapter count.
         */
        const expectedTotal = this.findTotalChapterCount(dom);

        if (
            expectedTotal != null &&
            chapterUrls.length < expectedTotal
        ) {
            throw new Error(
                `PYG-KIT chapter discovery incomplete: found ` +
                `${chapterUrls.length} of ${expectedTotal} chapters. ` +
                `The site's chapter-window layout may have changed.`
            );
        }

        if (
            chapterUrlsUI != null &&
            typeof chapterUrlsUI.setChapterUrls === "function"
        ) {
            chapterUrlsUI.setChapterUrls(chapterUrls);
        }

        return chapterUrls;
    }

    findTotalChapterCount(dom) {

        const bodyText = dom.body != null
            ? dom.body.textContent.replace(/\s+/g, " ")
            : "";

        // Examples:
        //   1 / 1039
        //   Chapters(1039)
        //   Chapters 1039
        const matches = [
            bodyText.match(/\b\d+\s*\/\s*(\d{1,6})\b/),
            bodyText.match(/\bChapters\s*\(\s*(\d{1,6})\s*\)/i),
            bodyText.match(/\bChapters\s+(\d{1,6})\b/i)
        ];

        for (const match of matches) {
            if (match != null) {
                const count = Number.parseInt(match[1], 10);

                if (Number.isSafeInteger(count) && count > 0) {
                    return count;
                }
            }
        }

        return null;
    }

    findFirstChapterLink(dom) {

        // Exact "First Chapter" link on the book page.
        let link = [...dom.querySelectorAll("a")].find(a =>
            a.textContent
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase() === "first chapter"
        );

        if (link != null) {
            return link;
        }

        // A few layouts use "Start Reading" for the first chapter.
        link = [...dom.querySelectorAll('a[href*="/chapters/"]')]
            .find(a => {
                const text = a.textContent
                    .replace(/\s+/g, " ")
                    .trim()
                    .toLowerCase();

                return (
                    text === "start reading" ||
                    /^chapter\s*1\b/i.test(text) ||
                    /^1\s*(?:this|the)\b/i.test(text)
                );
            });

        if (link != null) {
            return link;
        }

        // If already on a chapter page, use its current chapter URL.
        if (/\/chapters\/\d+(?:[/?#]|$)/.test(dom.baseURI)) {
            return dom.querySelector('a[href*="/chapters/"]');
        }

        // Last fallback.
        return dom.querySelector('a[href*="/chapters/"]');
    }

    findChapterLinks(dom) {

        const links = [];
        const seen = new Set();

        for (const link of dom.querySelectorAll(
            'a[href*="/chapters/"]'
        )) {

            const href = link.href;

            if (!href || !/\/chapters\/\d+(?:[/?#]|$)/.test(href)) {
                continue;
            }

            const text = link.textContent
                .replace(/\s+/g, " ")
                .trim();

            if (text.length === 0 || seen.has(href)) {
                continue;
            }

            seen.add(href);
            links.push(link);
        }

        return links;
    }

    getChapterPageId(url) {

        const match = url.match(
            /\/chapters\/(\d+)(?:[/?#]|$)/
        );

        return match != null
            ? Number.parseInt(match[1], 10)
            : Number.MAX_SAFE_INTEGER;
    }

    /**
     * Normalize all PYG-KIT chapter titles to:
     *
     *   Chapter 1: This rebirth is awesome
     *   Chapter 2: Nourishing Yin, Nourishing Kidney and Strengthening Pill
     *   Chapter 3: Renting a House
     *
     * Handles PYG-KIT's inconsistent forms:
     *   1This rebirth is awesome
     *   Next →Chapter 2: Nourishing Yin...
     *   3Renting a House
     *   1286 seconds 77
     *   404404 Warning!
     *   1035Shi Yi Shang Bin Brother
     */
    normalizeChapterTitle(link, chapterNumber) {

        let text = link.textContent
            .replace(/\s+/g, " ")
            .trim();

        // Remove navigation marker.
        text = text.replace(
            /^Next\s*→\s*/i,
            ""
        );

        // Remove an existing "Chapter N:" prefix.
        text = text.replace(
            /^Chapter\s+\d+\s*:\s*/i,
            ""
        );

        /*
         * The chapter number is known from the sorted position.
         * Remove EXACTLY that number from the beginning.
         *
         * This is important for malformed titles such as:
         *
         *   1286 seconds 77
         *
         * where removing all leading digits would incorrectly produce
         * chapter 1286. We instead remove only "128", leaving:
         *
         *   6 seconds 77
         *
         * Likewise:
         *   404404 Warning! -> 404 Warning!
         */
        const number = String(chapterNumber);

        if (text.startsWith(number)) {
            text = text.substring(number.length);
        }

        // Remove accidental colon/whitespace left after the number.
        text = text
            .replace(/^\s*:\s*/, "")
            .trim();

        // Some PYG-KIT links can contain a trailing "Current" marker.
        text = text
            .replace(/\s*←\s*Current\s*$/i, "")
            .trim();

        // Remove the site-added relative-time suffix if it appears in
        // a chapter-list link, e.g. "2 months ago".
        text = text
            .replace(/\s+\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\s*$/i, "")
            .trim();

        return `Chapter ${chapterNumber}: ${text}`;
    }

    findNextChapterLink(dom) {

        /*
         * The old implementation used text.includes("next"), which is
         * WRONG here because chapter titles themselves can contain
         * "next", e.g.:
         *
         *   "If you don’t add a bookshelf, can you see the next
         *    development of the story?"
         *
         * That caused the parser to mistake a normal chapter link for
         * the actual Next Chapter navigation and stop around Chapter 51.
         *
         * Only accept the site's navigation form:
         *
         *   Next →Chapter 52: ...
         *   Next → Chapter 52: ...
         */
        for (const link of dom.querySelectorAll(
            'a[href*="/chapters/"]'
        )) {

            const text = link.textContent
                .replace(/\s+/g, " ")
                .trim();

            if (
                /^Next\s*→\s*Chapter\s+\d+/i.test(text) &&
                /\/chapters\/\d+(?:[/?#]|$)/.test(link.href)
            ) {
                return link;
            }
        }

        return null;
    }

    findContent(dom) {

        let content = dom.querySelector(".mb-10");

        if (content != null) {
            return content;
        }

        content = dom.querySelector(
            "article .prose, main .prose, article, main"
        );

        if (content != null) {
            return content;
        }

        throw new Error(
            "Could not find PYG-KIT chapter content."
        );
    }

    extractTitleImpl(dom) {

        const title = dom.querySelector("h1");

        if (title == null) {
            return null;
        }

        let text = title.textContent
            .replace(/\s+/g, " ")
            .trim();

        text = text.replace(
            /^chapter\s+\d+\s*:\s*/i,
            ""
        );

        return text;
    }

    findChapterTitle(dom) {

        const title = dom.querySelector("h1");

        if (title == null) {
            return null;
        }

        return title.textContent
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * PYG-KIT book metadata
     *
     * Book page structure currently exposes:
     *   - Genre/category chips near the title
     *   - Description/synopsis
     *   - #tag links
     *
     * The WebToEpub base Parser maps:
     *   extractDescription() -> EPUB description
     *   extractSubject()     -> EPUB dc:subject
     *
     * We keep the site's own wording rather than inventing metadata.
     */
    /**
     * Extract the book description from PYG-KIT's Schema.org JSON-LD.
     *
     * PYG-KIT exposes the real synopsis in:
     *   <script type="application/ld+json">
     *
     * Do NOT use meta[name="description"] as a fallback here. On the
     * current site that metadata can contain the page's structured JSON
     * blob, which is what caused the entire JSON-LD/FAQ text to appear
     * inside the EPUB description.
     */
    extractDescription(dom) {

        const jsonLd = this.getBookJsonLd(dom);

        if (jsonLd != null) {

            const description = jsonLd.description;

            if (typeof description === "string") {
                return description
                    .replace(/\s+/g, " ")
                    .trim();
            }
        }

        /*
         * DOM fallback: use only the actual synopsis area, stopping
         * before "Show more" and before the hashtag section.
         */
        const main = dom.querySelector("main");

        if (main != null) {

            const text = main.textContent
                .replace(/\u00a0/g, " ")
                .replace(/\s+/g, " ")
                .trim();

            const start = text.search(
                /Other names for this book\s*:/i
            );

            const showMore = text.search(
                /\bShow more\b/i
            );

            if (start >= 0) {

                const end =
                    showMore > start
                        ? showMore
                        : text.search(/#Reincarnation\b/i);

                if (end > start) {
                    return text.substring(start, end).trim();
                }
            }
        }

        return "";
    }

    /**
     * Return the Book/Novel JSON-LD object from PYG-KIT.
     */
    getBookJsonLd(dom) {

        for (const script of dom.querySelectorAll(
            'script[type="application/ld+json"]'
        )) {

            const raw = script.textContent
                .replace(/^\uFEFF/, "")
                .trim();

            if (!raw) {
                continue;
            }

            try {

                const data = JSON.parse(raw);

                const candidates = Array.isArray(data)
                    ? data
                    : Array.isArray(data["@graph"])
                        ? data["@graph"]
                        : [data];

                for (const item of candidates) {

                    if (
                        item != null &&
                        typeof item === "object" &&
                        (
                            item["@type"] === "Book" ||
                            item["@type"] === "Novel" ||
                            item.name === dom.querySelector("h1")?.textContent?.trim()
                        )
                    ) {
                        return item;
                    }
                }

            } catch (error) {
                // Ignore unrelated/invalid JSON-LD and continue searching.
            }
        }

        return null;
    }

    /**
     * EPUB dc:subject:
     *
     *   Genres first:
     *     Male Lead, Slice of Life, Urban Life, Chinese
     *
     *   Then PYG-KIT's actual #tags:
     *     Reincarnation, System, ...
     *
     * IMPORTANT:
     * Never scan every <a> element for text here. The book page also
     * contains the Latest Chapters links, which is why the previous
     * parser accidentally added:
     *
     *   1039Extra: Zhang Gonglian (Part 2)
     *   1038Extra: Zhang Gonglian (Part 1)
     *   ...
     *
     * as metadata.
     */
    extractSubject(dom) {

        const subjects = [];

        const addSubject = value => {

            value = value
                .replace(/^#+/, "")
                .replace(/\s+/g, " ")
                .trim();

            if (
                value &&
                !subjects.some(
                    existing =>
                        existing.toLowerCase() === value.toLowerCase()
                )
            ) {
                subjects.push(value);
            }
        };

        /*
         * Genres/categories are the four links immediately associated
         * with the book header. PYG-KIT uses:
         *
         *   /en/novels?genre=...
         */
        for (const link of dom.querySelectorAll(
            'a[href*="/novels?genre="]'
        )) {
            addSubject(link.textContent);
        }

        /*
         * PYG-KIT's actual book tags use /search?q=... links.
         *
         * IMPORTANT: Do NOT scan all <a> elements for visible text that
         * starts with '#'. The Latest Chapters section also uses chapter
         * links whose visible text starts with '#', for example:
         *   #1039Extra: Zhang Gonglian (Part 2)2 months ago
         * Those are chapter entries, not tags.
         *
         * Restricting the extraction to the site's tag-search URL is the
         * reliable boundary between real tags and chapter navigation.
         */
        const main = dom.querySelector("main");

        if (main != null) {

            for (const link of main.querySelectorAll(
                'a[href*="/search?"]'
            )) {

                const value = link.textContent
                    .replace(/\s+/g, " ")
                    .trim();

                const href = link.getAttribute("href") || "";

                /*
                 * A real tag is displayed as #Tag and points to the
                 * search endpoint. Chapter links point to /chapters/.
                 */
                if (
                    href.includes("/search?") &&
                    /^#[^#]+$/.test(value) &&
                    !/^#\d+/.test(value)
                ) {
                    addSubject(value);
                }
            }
        }

        return subjects.join(", ");
    }


    extractAuthor(dom) {

        const authorLink = dom.querySelector(
            'a[href*="/authors/"], a[href*="/author/"]'
        );

        if (authorLink != null) {
            return authorLink.textContent
                .replace(/\s+/g, " ")
                .trim();
        }

        const elements = [
            ...dom.querySelectorAll("body *")
        ];

        for (const element of elements) {

            const text = element.textContent
                .replace(/\s+/g, " ")
                .trim();

            if (
                /^author\s*:/i.test(text) &&
                element.children.length <= 2
            ) {

                const match = text.match(
                    /^author\s*:\s*(.+)$/i
                );

                if (match != null) {
                    return match[1].trim();
                }
            }
        }

        return super.extractAuthor(dom);
    }

    extractLanguage() {
        return "en";
    }

    findCoverImageUrl(dom) {

        let image = dom.querySelector(
            'img[alt*="After Rebirth" i]'
        );

        if (image != null) {
            return image.src;
        }

        image = dom.querySelector(
            "main img, article img"
        );

        if (image != null) {
            return image.src;
        }

        return null;
    }

    removeUnwantedElementsFromContentElement(element) {

        const selectors = [
            "nav",
            "header",
            "footer",
            "script",
            "style",
            "noscript",
            ".comments",
            ".comment",
            ".chapter-navigation",
            ".chapter-nav",
            ".pagination",
            "[aria-label='Comments']"
        ];

        for (const selector of selectors) {
            element.querySelectorAll(selector)
                .forEach(node => node.remove());
        }

        super.removeUnwantedElementsFromContentElement(element);
    }
}
