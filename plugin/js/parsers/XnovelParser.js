"use strict";

parserFactory.register("xnovel.app", () => new XnovelParser());

class XnovelParser extends Parser {
    constructor() {
        super();
    }

    async getChapterUrls(dom) {
        let chapters = this.extractSerializedChapterUrls(dom);

        if (chapters.length > 0) {
            return chapters;
        }

        // Fallback for pages where XNovel's serialized chapter state is absent.
        let chapterLinks = [
            ...dom.querySelectorAll(
                "div[data-name='chapter-list-content'] a[href*='-chapter-']"
            )
        ];

        let seen = new Set();
        return chapterLinks
            .map(link => util.hyperLinkToChapter(link))
            .filter(chapter => {
                if (!chapter?.sourceUrl || seen.has(chapter.sourceUrl)) {
                    return false;
                }
                seen.add(chapter.sourceUrl);
                return true;
            });
    }

    extractSerializedChapterUrls(dom) {
        let chapters = new Map();

        for (let script of dom.querySelectorAll("script")) {
            let text = script.textContent ?? "";
            if (!text.includes("-chapter-")) {
                continue;
            }

            // XNovel's Qwik SSR state contains records in the form:
            // "chapterId",chapterNumber,"Chapter title","/novel/chapter-slug"
            // and for the latest chapter an extra "0" field before the number.
            let pattern =
                /"(\d+)",(?:\d+",)?(\d+),"((?:\\.|[^"\\])*)","(\/[^"\\]*-chapter-[^"\\]*)"/g;

            let match;
            while ((match = pattern.exec(text)) != null) {
                let sequence = Number(match[2]);
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
                if (!chapters.has(sequence)) {
                    chapters.set(sequence, {
                        sourceUrl,
                        title
                    });
                }
            }
        }

        return [...chapters.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, chapter]) => chapter);
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
        return this.extractSchemaBook(dom)?.name
            ?? this.getMetaContent(dom, "meta[property='og:title']")
            ?? super.extractTitleImpl(dom);
    }

    extractAuthor(dom) {
        let author = this.extractSchemaBook(dom)?.author;
        if (Array.isArray(author)) {
            author = author[0];
        }

        return author?.name
            ?? this.getMetaContent(dom, "meta[name='author']")
            ?? super.extractAuthor(dom);
    }

    extractSubject(dom) {
        let genres = this.extractSchemaBook(dom)?.genre;
        if (Array.isArray(genres)) {
            return genres.filter(Boolean).join(", ");
        }

        return this.getMetaContent(dom, "meta[name='keywords']");
    }

    extractDescription(dom) {
        return this.extractSchemaBook(dom)?.description
            ?? this.getMetaContent(dom, "meta[name='description']")
            ?? "";
    }

    findCoverImageUrl(dom) {
        let image = this.extractSchemaBook(dom)?.image
            ?? this.getMetaContent(dom, "meta[property='og:image']");

        if (image == null || image === "") {
            return null;
        }

        return new URL(image, dom.baseURI).href;
    }

    extractSchemaBook(dom) {
        for (let script of dom.querySelectorAll("script[type='application/ld+json']")) {
            try {
                let data = JSON.parse(script.textContent);
                if (data?.["@type"] === "Book") {
                    return data;
                }
            } catch (error) {
                // Ignore malformed JSON-LD and use normal DOM fallbacks.
            }
        }

        return null;
    }

    getMetaContent(dom, selector) {
        return dom.querySelector(selector)?.getAttribute("content")?.trim() ?? "";
    }

    removeUnwantedElementsFromContentElement(element) {
        util.removeChildElementsMatchingSelector(element, "style");
        super.removeUnwantedElementsFromContentElement(element);
    }
}
