"use strict";

parserFactory.register("xnovel.app", () => new XnovelParser());

class XnovelParser extends Parser {
    constructor() {
        super();
    }

    async getChapterUrls(dom) {
        let novelPath = this.getNovelPath(dom);
        let chapterLinks = this.getChapterLinks(dom, novelPath);

        // The novel page renders only the latest chapter batch. Fetch chapter
        // 1 once: XNovel embeds the complete chapter dataset in its Qwik SSR
        // state, so there is no need to request hundreds of chapter pages.
        let firstChapter = chapterLinks.find(chapter =>
            /^Chapter\s+1(?:\D|$)/i.test(chapter.title ?? "")
        );

        if (firstChapter != null) {
            try {
                let response = await HttpClient.wrapFetch(firstChapter.sourceUrl);
                let chapterDom = response.responseXML;

                if (chapterDom != null) {
                    let serialized = this.extractSerializedChapterUrls(
                        chapterDom,
                        novelPath
                    );

                    if (serialized.length > chapterLinks.length) {
                        chapterLinks = serialized;
                    }
                }
            } catch (error) {
                // Keep the links already available on the novel page.
            }
        }

        return this.sortChapterLinks(chapterLinks);
    }

    getNovelPath(dom) {
        let canonical = dom.querySelector("link[rel='canonical']")?.href;
        if (canonical == null) {
            return null;
        }

        let url = new URL(canonical, dom.baseURI);
        let match = url.pathname.match(
            /^\/([^/]+?)(?:\/\d+-chapter-[^/]+)?\/?$/
        );

        return match?.[1] ?? null;
    }

    getChapterLinks(dom, novelPath) {
        let result = [];
        let seen = new Set();

        for (let link of dom.querySelectorAll("a[href*='-chapter-']")) {
            let chapter = util.hyperLinkToChapter(link);

            if (
                chapter?.sourceUrl == null ||
                !this.isNovelChapter(chapter.sourceUrl, novelPath) ||
                seen.has(chapter.sourceUrl)
            ) {
                continue;
            }

            seen.add(chapter.sourceUrl);
            result.push(chapter);
        }

        return result;
    }

    isNovelChapter(sourceUrl, novelPath) {
        if (novelPath == null) {
            return true;
        }

        return new URL(sourceUrl).pathname.startsWith(`/${novelPath}/`);
    }

    extractSerializedChapterUrls(dom, novelPath) {
        if (novelPath == null) {
            return [];
        }

        // Qwik serializes chapter records as:
        // "chapterId",chapterNumber,"Chapter title","/novel/chapter-slug"
        // (the latest record may have an extra "0" before chapterNumber).
        // Parse broadly, then filter by this novel's path. This is important
        // because the same SSR page also contains unrelated novel records.
        let pattern =
            /"(\d+)",(?:(?:"0",)?(\d+),)?"((?:\\.|[^"\\])*)",(?:null,)?"(\/[^"\\]*-chapter-[^"\\]*)"/g;
        let chapters = new Map();
        let lastSequence = 0;

        for (let script of dom.querySelectorAll("script")) {
            let text = script.textContent ?? "";

            if (!text.includes(`/${novelPath}/`) || !text.includes("-chapter-")) {
                continue;
            }

            let match;

            while ((match = pattern.exec(text)) != null) {
                let sequence = match[2] == null
                    ? lastSequence + 1
                    : Number(match[2]);

                if (!Number.isInteger(sequence) || sequence < 1) {
                    continue;
                }

                let title;
                let path;

                try {
                    title = JSON.parse(`"${match[3]}"`);
                    path = JSON.parse(`"${match[4]}"`);
                } catch (error) {
                    continue;
                }

                let sourceUrl = new URL(path, dom.baseURI).href;

                if (!this.isNovelChapter(sourceUrl, novelPath)) {
                    continue;
                }

                lastSequence = sequence;

                if (!chapters.has(sequence)) {
                    chapters.set(sequence, {
                        sourceUrl,
                        title
                    });
                }
            }
        }

        // Chapter 1 has a different Qwik record shape on the reading
        // page, so add it directly from the canonical URL and h6 heading.
        let canonical = dom.querySelector("link[rel='canonical']")?.href;
        let titleElement = dom.querySelector("h6");
        if (canonical != null && titleElement != null) {
            let sourceUrl = new URL(canonical, dom.baseURI).href;
            if (this.isNovelChapter(sourceUrl, novelPath)) {
                chapters.set(1, {
                    sourceUrl,
                    title: titleElement.textContent.trim()
                });
            }
        }

        return [...chapters.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, chapter]) => chapter);
    }

    sortChapterLinks(chapters) {
        // XNovel uses split chapter numbers such as 370.1 and 370.2.
        return chapters.sort((a, b) => {
            let aNumber = this.chapterNumber(a.title);
            let bNumber = this.chapterNumber(b.title);

            if (aNumber == null || bNumber == null) {
                return 0;
            }

            return aNumber - bNumber;
        });
    }

    chapterNumber(title) {
        let match = title?.match(/^Chapter\s+(\d+(?:\.\d+)?)/i);
        return match == null ? null : Number(match[1]);
    }
    findContent(dom) {
        let contentElements = [...dom.querySelectorAll("div.novel-content-area")];

        if (contentElements.length === 0) {
            return null;
        }

        let content = dom.createElement("div");
        for (let element of contentElements) {
            for (let child of [...element.childNodes]) {
                content.appendChild(child.cloneNode(true));
            }
        }

        return content;
    }

    findChapterTitle(dom) {
        return dom.querySelector("h6");
    }

    extractTitleImpl(dom) {
        return (
            dom.querySelector("h3 a[href]")?.textContent?.trim()
            ?? this.getMetaContent(dom, "meta[property='og:title']")
                .replace(/\s+-\s+(?:Your novels, Your library, Your world|Watching free novel on Xnovel).*$/i, "")
                .trim()
            ?? super.extractTitleImpl(dom)
        );
    }

    extractAuthor(dom) {
        return (
            dom.querySelector("a[href^='/author/']")?.textContent?.trim()
            ?? this.extractAuthorFromKeywords(dom)
            ?? super.extractAuthor(dom)
        );
    }

    extractSubject(dom) {
        let keywords = this.getMetaContent(dom, "meta[name='keywords']");
        if (keywords === "") {
            return "";
        }

        let values = keywords
            .split(",")
            .map(value => value.trim())
            .filter(Boolean);

        // On novel pages XNovel currently exposes only "novel, xnovel" in
        // keywords. The real genres are rendered in the visible Genres block.
        let genreLabel = [...dom.querySelectorAll("b")]
            .find(element => /^Genres:\s*$/i.test(element.textContent.trim()));

        if (genreLabel?.parentElement != null) {
            let genres = [...genreLabel.parentElement.querySelectorAll("a")]
                .map(element => element.textContent.trim())
                .filter(Boolean);

            if (genres.length > 0) {
                return [...new Set(genres)].join(", ");
            }
        }

        // Chapter pages contain the complete metadata in their keywords.
        let author = values[1];
        let knownGenres = new Set([
            "action", "adventure", "adult", "anime", "comedy", "drama",
            "ecchi", "fantasy", "harem", "historical", "horror", "isekai",
            "martial_arts", "mystery", "romance", "school-life", "sci-fi",
            "slice_of_life", "tragedy", "wuxia", "xianxia", "xuanhuan"
        ]);

        let genres = values
            .slice(2)
            .filter(value => knownGenres.has(value.toLowerCase()));

        return genres.join(", ");
    }

    extractAuthorFromKeywords(dom) {
        let keywords = this.getMetaContent(dom, "meta[name='keywords']");
        let values = keywords.split(",").map(value => value.trim()).filter(Boolean);

        return values.length > 1 && !/^(novel|xnovel)$/i.test(values[1])
            ? values[1]
            : null;
    }

    extractDescription(dom) {
        return (
            this.getMetaContent(dom, "meta[name='description']")
            ?? ""
        );
    }

    findCoverImageUrl(dom) {
        let image =
            this.getMetaContent(dom, "meta[property='og:image']")
            || dom.querySelector("img[src*='/media/ncov/']")?.src;

        if (image == null || image === "") {
            return null;
        }

        return new URL(image, dom.baseURI).href;
    }

    getMetaContent(dom, selector) {
        return dom.querySelector(selector)?.getAttribute("content")?.trim() ?? "";
    }

    removeUnwantedElementsFromContentElement(element) {
        util.removeChildElementsMatchingSelector(element, "style");
        super.removeUnwantedElementsFromContentElement(element);
    }
}
