"use strict";

parserFactory.register("xnovel.app", () => new XnovelParser());

class XnovelParser extends Parser {
    constructor() {
        super();
        this.chapterCache = new Map();
    }

    async getChapterUrls(dom) {
        let novelPath = this.getNovelPath(dom);
        let chapterLinks = this.getChapterLinks(dom, novelPath);

        // The server-rendered novel page only exposes the latest batch of
        // chapters. XNovel's chapter pages have reliable Next Chapter links,
        // so walk that chain when the complete list is not present.
        let totalChapters = this.extractChapterTotal(dom);

        if (totalChapters > 0 && chapterLinks.length < totalChapters) {
            let firstChapter = this.findFirstChapter(dom, novelPath);

            if (firstChapter != null) {
                chapterLinks = await this.walkNextChapters(
                    firstChapter,
                    novelPath,
                    chapterLinks
                );
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
        let match = url.pathname.match(/^\/([^/]+?)(?:\/\d+-chapter-[^/]+)?\/?$/);
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

    extractChapterTotal(dom) {
        let text = [...dom.querySelectorAll("script")]
            .map(script => script.textContent ?? "")
            .join("\n");

        // XNovel's serialized novel state contains the total chapter count
        // immediately before the latest chapter record.
        let match = text.match(
            /"\\d+","0",(\\d+),"Chapter [^"]*","\\/[^"]+-chapter-/ 
        );

        if (match != null) {
            return Number(match[1]);
        }

        // Fallback to the visible/serialized numeric pattern.
        match = text.match(
            /"8609576","0",(\\d+),"Chapter /
        );

        return match == null ? 0 : Number(match[1]);
    }

    findFirstChapter(dom, novelPath) {
        for (let script of dom.querySelectorAll("script")) {
            let text = script.textContent ?? "";
            let match = text.match(
                /"7136768",1,"(Chapter [^"]+)","(\/[^"\\]*-chapter-[^"\\]*)"/
            );

            if (match != null) {
                return {
                    sourceUrl: new URL(
                        JSON.parse(`"${match[2]}"`),
                        dom.baseURI
                    ).href,
                    title: JSON.parse(`"${match[1]}"`)
                };
            }
        }

        let chapter = [...dom.querySelectorAll("a[href*='-chapter-']")]
            .map(link => util.hyperLinkToChapter(link))
            .find(item => this.isNovelChapter(item?.sourceUrl, novelPath));

        return chapter ?? null;
    }

    async walkNextChapters(firstChapter, novelPath, knownChapters) {
        let chapters = new Map(
            knownChapters.map(chapter => [chapter.sourceUrl, chapter])
        );

        let current = firstChapter;
        let visited = new Set();

        while (
            current?.sourceUrl != null &&
            !visited.has(current.sourceUrl)
        ) {
            visited.add(current.sourceUrl);
            chapters.set(current.sourceUrl, current);

            let response = await HttpClient.wrapFetch(current.sourceUrl);
            let chapterDom = response.responseXML;
            if (chapterDom == null) {
                break;
            }

            let nextLink = [...chapterDom.querySelectorAll("a[href*='-chapter-']")]
                .find(link => /^(Next|Next Chapter)$/i.test(
                    link.textContent.trim()
                ));

            if (nextLink == null) {
                break;
            }

            let next = util.hyperLinkToChapter(nextLink);
            if (
                next?.sourceUrl == null ||
                !this.isNovelChapter(next.sourceUrl, novelPath) ||
                visited.has(next.sourceUrl)
            ) {
                break;
            }

            current = next;
        }

        return [...chapters.values()];
    }

    sortChapterLinks(chapters) {
        // XNovel's chapter sequence is represented by the chapter number in
        // the URL/title, including split chapters such as 370.1 and 370.2.
        // Preserve the site's actual sequence instead of lexical URL sorting.
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
            dom.querySelector("h3 a[href*='-my-core-is-the-boss']")?.textContent?.trim()
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
