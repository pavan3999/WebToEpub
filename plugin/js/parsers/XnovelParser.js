"use strict";

parserFactory.register("xnovel.app", () => new XnovelParser());

class XnovelParser extends Parser {
    constructor() {
        super();
    }

    async getChapterUrls(dom) {
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
            })
            .reverse();
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
        return dom.querySelector("meta[property='og:title']");
    }

    extractAuthor(dom) {
        return dom.querySelector("meta[name='author']")
            ?? super.extractAuthor(dom);
    }

    extractSubject(dom) {
        return dom.querySelector("meta[name='keywords']");
    }

    extractDescription(dom) {
        return dom.querySelector("meta[name='description']");
    }

    findCoverImageUrl(dom) {
        return dom.querySelector("meta[property='og:image']")?.content ?? null;
    }

    removeUnwantedElementsFromContentElement(element) {
        util.removeChildElementsMatchingSelector(element, "style");
        super.removeUnwantedElementsFromContentElement(element);
    }
}
