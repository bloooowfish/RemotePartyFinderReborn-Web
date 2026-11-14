(function () {
    const colours = [
        '#D32F2F',
        '#1976D2',
        '#FBC02D',
        '#388E3C',
        '#7B1FA2',
        '#F57C00',
        '#5D4037',
        '#455A64',
        '#00796B',
        '#E64A19',
        '#C2185B',
        '#512DA8',
        '#0097A7',
    ];

    const options = {
        plugins: {
            tooltip: {
                callbacks: {
                    label: function (context) {
                        let total = context.dataset.data.reduce((total, next) => total + next);
                        let percentage = (context.raw / total * 100).toFixed(2);

                        return `${context.label} (${context.raw}, ${percentage}%)`;
                    }
                }
            },
            legend: {
                display: false,
            },
        },
    };

    function otherLabel() {
        return (typeof window !== 'undefined' && window.RPF_STATS_I18N?.otherLabel) || 'Other';
    }

    function formatTreeMapTooltip(label, percent, countText) {
        if (typeof window !== 'undefined' && window.RPF_STATS_I18N?.formatTreeMapTooltip) {
            return window.RPF_STATS_I18N.formatTreeMapTooltip(label, percent, countText);
        }
        return `${label} (${percent}% - ${countText})`;
    }

    function formatBarTooltip(label, countText, percent) {
        if (typeof window !== 'undefined' && window.RPF_STATS_I18N?.formatBarTooltip) {
            return window.RPF_STATS_I18N.formatBarTooltip(label, countText, percent);
        }
        return `${label}: ${countText} (${percent}%)`;
    }

    function relativeLuminance(hex) {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return 0;
        const num = parseInt(match[1], 16);
        const channels = [(num >> 16) & 255, (num >> 8) & 255, num & 255].map((value) => {
            const srgb = value / 255;
            return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }

    function contrastTextColor(bgColor) {
        return relativeLuminance(bgColor) > 0.22 ? '#1a1a1a' : '#ffffff';
    }

    function sequentialHourColor(value, maxValue) {
        const ratio = maxValue > 0 ? Math.max(0, Math.min(1, value / maxValue)) : 0;
        const start = [30, 58, 95];
        const end = [96, 165, 250];
        const r = Math.round(start[0] + (end[0] - start[0]) * ratio);
        const g = Math.round(start[1] + (end[1] - start[1]) * ratio);
        const b = Math.round(start[2] + (end[2] - start[2]) * ratio);
        return `rgb(${r}, ${g}, ${b})`;
    }

    function combineUnderMedian(data) {
        let midpoint = Math.trunc(data.length / 2);
        let wasOdd = data.length % 2 === 1;
        let median;
        if (wasOdd) {
            median = (data[midpoint].y + data[midpoint + 1].y) / 2;
        } else {
            median = data[midpoint].y;
        }

        let newData = [];
        let other = {
            x: otherLabel(),
            y: 0,
        };

        for (let entry of data) {
            if (entry.y <= median) {
                other.y += 1;
                continue;
            }

            newData.push(entry);
        }

        newData.push(other);

        return newData;
    }

    function combineTopN(data, n) {
        let newData = [];

        let other = {
            x: otherLabel(),
            y: 0,
        };

        for (let i = 0; i < data.length; i++) {
            if (i < n) {
                newData.push(data[i]);
                continue;
            }

            other.y += data[i].y;
        }

        newData.push(other);

        return newData;
    }

    function extractData(tableId, extractor = null) {
        if (extractor === null) {
            extractor = (cols) => {
                return {
                    label: cols[0].textContent.trim(),
                    value: Number(cols[1].textContent.trim()),
                };
            };
        }

        let table = document.getElementById(tableId);
        let data = [];
        for (let row of table.querySelectorAll('tbody > tr')) {
            let cols = row.querySelectorAll('td');
            data.push(extractor(cols));
        }

        return data;
    }

    function tokenizeForWrap(text) {
        const chunks = [];
        for (const part of String(text || '').trim().split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) continue;
            // Split contiguous CJK characters when not separated by whitespace so Japanese/CJK text wraps cleanly.
            if (/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\uff00-\uffef]/.test(part)) {
                for (const char of Array.from(part)) {
                    chunks.push({ text: char, joinWithSpace: false });
                }
            } else {
                chunks.push({ text: part, joinWithSpace: true });
            }
        }
        return chunks;
    }

    function measureTspanWidth(tspan, textValue) {
        tspan.text(textValue);
        const node = tspan.node();
        if (node && typeof node.getComputedTextLength === 'function') {
            return node.getComputedTextLength();
        }
        return textValue.length * 8;
    }

    function wrap(selection) {
        selection.each(function () {
            const textEl = d3.select(this);
            const rawText = textEl.text();
            const availableWidth = Math.max(24, Number(textEl.attr('width') || 0) - 10);
            const maxLines = Math.max(1, Number(textEl.attr('data-max-lines') || 6));
            const x = textEl.attr('x');
            const y = textEl.attr('y');
            const lineHeight = 1.15;
            const tokens = tokenizeForWrap(rawText);

            textEl.text(null);
            let tspan = textEl.append('tspan')
                .attr('x', x)
                .attr('y', y)
                .attr('dy', '0em');

            if (tokens.length === 0) return;

            let lineTokens = [];
            let lineNumber = 0;

            const renderLine = (items) => {
                let out = '';
                for (let idx = 0; idx < items.length; idx += 1) {
                    const token = items[idx];
                    if (idx > 0 && (token.joinWithSpace || items[idx - 1].joinWithSpace)) {
                        out += ' ';
                    }
                    out += token.text;
                }
                return out;
            };

            for (let i = 0; i < tokens.length; i += 1) {
                const token = tokens[i];
                const candidate = [...lineTokens, token];
                const candidateText = renderLine(candidate);

                if (measureTspanWidth(tspan, candidateText) > availableWidth && lineTokens.length > 0) {
                    tspan.text(renderLine(lineTokens));
                    lineNumber += 1;
                    if (lineNumber >= maxLines) {
                        let truncated = renderLine(lineTokens);
                        while (truncated.length > 1 && measureTspanWidth(tspan, `${truncated}…`) > availableWidth) {
                            truncated = truncated.slice(0, -1).trimEnd();
                        }
                        tspan.text(`${truncated}…`);
                        return;
                    }
                    lineTokens = [token];
                    tspan = textEl.append('tspan')
                        .attr('x', x)
                        .attr('y', y)
                        .attr('dy', `${lineNumber * lineHeight}em`);
                    tspan.text(token.text);
                } else {
                    lineTokens = candidate;
                    tspan.text(candidateText);
                }
            }
        });
    }

    function makeTreeMap(data, graphId, opts = {}) {
        let drawLabels = opts.drawLabels === undefined ? true : opts.drawLabels;
        let grouped = opts.grouped === undefined ? false : opts.grouped;

        let elem = document.getElementById(graphId);
        const totalWidth = Math.max(280, elem.offsetWidth || 640);
        const totalHeight = Math.max(220, elem.offsetHeight || 360);
        const isCompact = totalWidth < 520;
        const [width, height] = [totalWidth, totalHeight];

        let svg = d3.select(`#${graphId}`)
                    .append('svg')
                    .attr('viewBox', `0 0 ${width} ${height}`);

        if (grouped) {
            d3.treemap()
              .size([width, height])
              .paddingInner(2)
              .paddingTop(4)
              .paddingRight(4)
              .paddingLeft(4)
              .paddingBottom(4)
            (data);
        } else {
            d3.treemap()
              .size([width, height])
              .paddingInner(2)
            (data);
        }

        const leaves = data.leaves();
        leaves.forEach((leaf, index) => {
            leaf._fill = colours[index % colours.length];
            leaf._clipId = `${graphId}-clip-${index}`;
        });

        const defs = svg.append('defs');
        defs.selectAll('clipPath')
            .data(leaves)
            .enter()
            .append('clipPath')
            .attr('id', (d) => d._clipId)
            .append('rect')
            .attr('x', (d) => d.x0 + 2)
            .attr('y', (d) => d.y0 + 2)
            .attr('width', (d) => Math.max(0, d.x1 - d.x0 - 4))
            .attr('height', (d) => Math.max(0, d.y1 - d.y0 - 4));

        let group = svg.selectAll('g.treemap-leaf')
                       .data(leaves)
                       .enter()
                       .append('g')
                       .attr('class', 'treemap-leaf');

        let title = (d) => formatTreeMapTooltip(
            d.data.label,
            (d.data.value / d.parent.value * 100).toFixed(2),
            d.data.value.toLocaleString(),
        );

        group
            .append('title')
            .text(title);

        group
            .append('rect')
            .attr('x', d => d.x0)
            .attr('y', d => d.y0)
            .attr('width', d => d.x1 - d.x0)
            .attr('height', d => d.y1 - d.y0)
            .style('fill', d => d._fill);

        if (drawLabels) {
            const labelFontSize = isCompact ? '12px' : '14px';
            const linePx = isCompact ? 15 : 17;
            svg.selectAll('text.treemap-label')
               .data(leaves.filter(d => d.data.value / d.parent.value >= .05 ))
               .enter()
               .append('text')
               .attr('class', 'treemap-label')
               .attr('x', d => d.x0 + 5)
               .attr('y', d => d.y0 + (isCompact ? 17 : 20))
               .attr('width', d => d.x1 - d.x0)
               .attr('data-max-lines', d => Math.max(1, Math.floor((d.y1 - d.y0 - 10) / linePx)))
               .attr('clip-path', d => `url(#${d._clipId})`)
               .text(title)
               .attr('font-size', labelFontSize)
               .attr('fill', d => contrastTextColor(d._fill))
               .call(wrap);
        }

        if (grouped) {
            svg.selectAll('rect.treemap-border')
               .data(data.descendants().filter(d => d.depth === 1))
               .enter()
               .append('rect')
               .attr('class', 'treemap-border')
               .attr('x', d => d.x0)
               .attr('y', d => d.y0)
               .attr('width', d => d.x1 - d.x0)
               .attr('height', d => d.y1 - d.y0)
               .attr('fill', 'none')
               .attr('stroke', '#374956');

            svg.selectAll('text.treemap-group-title')
               .data(data.descendants().filter(d => d.depth === 1))
               .enter()
               .append('text')
               .attr('class', 'treemap-group-title')
               .attr('x', d => d.x1 - 2)
               .attr('y', d => d.y1 - 2)
               .attr('text-anchor', 'end')
               .style('transform', d => {
                   if ((d.x1 - d.x0) < (d.y1 - d.y0)) {
                       return 'rotate(90deg)';
                   }

                   return null;
               })
               .style('transform-box', 'fill-box')
               .style('transform-origin', '95%')
               .text(d => d.data[0])
               .attr("font-size", d => {
                   if (d === data) {
                       return isCompact ? "12px" : "14px";
                   }
                   let w = d.x1 - d.x0, h = d.y1 - d.y0;
                   return Math.max(Math.min(w/5, h/2, Math.sqrt((w*w + h*h))/10), isCompact ? 10 : 11);
               })
               .attr('fill', 'white');
        }
    }

    function makeBarPlot(data, graphId, opts = {}) {
        if (!Array.isArray(data) || data.length === 0) {
            return;
        }

        let elem = document.getElementById(graphId);
        const totalWidth = Math.max(280, elem.offsetWidth || 640);
        const totalHeight = Math.max(220, elem.offsetHeight || 360);
        const isCompact = totalWidth < 520;
        const [marginLeft, marginRight, marginTop, marginBottom] = isCompact
            ? [44, 12, 16, 42]
            : [72, 20, 16, 52];
        const [width, height] = [
            Math.max(120, totalWidth - marginLeft - marginRight),
            Math.max(100, totalHeight - marginTop - marginBottom),
        ];

        let svg = d3.select(`#${graphId}`)
                    .append('svg')
                    .attr('viewBox', `0 0 ${width + marginLeft + marginRight} ${height + marginTop + marginBottom}`)
                    .append('g')
                    .attr('transform', `translate(${marginLeft}, ${marginTop})`);

        let x = d3.scaleBand()
                  .range([0, width])
                  .domain(data.map(d => d.label))
                  .padding(0.2);

        const labelIndex = new Map(data.map((d, i) => [d.label, i]));
        const xAxis = d3.axisBottom(x).tickFormat((label) => {
            if (isCompact && data.length > 12) {
                const idx = labelIndex.get(label) ?? 0;
                return idx % 3 === 0 ? label : '';
            }
            return label;
        });

        const axisFontSize = isCompact ? '11px' : '13px';
        svg.append('g')
           .attr('transform', `translate(0, ${height})`)
           .call(xAxis)
           .attr('font-size', axisFontSize)
           .selectAll('text')
           .style('text-anchor', 'middle')
           .attr('font-size', axisFontSize);

        const maxValue = data.map(d => d.value).reduce((max, a) => Math.max(max, a), 0);
        let y = d3.scaleLinear()
                  .domain([0, maxValue])
                  .range([height, 0]);
        svg.append('g')
           .call(d3.axisLeft(y).ticks(isCompact ? 5 : 8))
           .attr('font-size', axisFontSize)
           .selectAll('text')
           .attr('font-size', axisFontSize);

        let sum = data.map(d => d.value).reduce((total, a) => total + a, 0);
        let colourIdx = 0;
        const useSequential = opts.colorScale === 'sequential';
        let group = svg.selectAll('mybar')
                       .data(data)
                       .enter()
                       .append('g');
        group.append('title')
             .text(d => {
                 const percentage = sum > 0 ? (d.value / sum * 100).toFixed(2) : '0.00';
                 return formatBarTooltip(d.label, d.value.toLocaleString(), percentage);
             });
        group.append('rect')
             .attr('x', d => x(d.label))
             .attr('y', d => y(d.value))
             .attr('width', x.bandwidth())
             .attr('height', d => height - y(d.value))
             .attr('fill', d => {
                 if (useSequential) {
                     return sequentialHourColor(d.value, maxValue);
                 }
                 let colour = colours[colourIdx];
                 colourIdx += 1;
                 colourIdx %= colours.length;
                 return colour;
             });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports.__test__ = {
            contrastTextColor,
            extractData,
            makeBarPlot,
            makeTreeMap,
            relativeLuminance,
            sequentialHourColor,
            tokenizeForWrap,
            wrap,
        };
        return;
    }

    makeTreeMap(
        d3.hierarchy({
            children: extractData('duties'),
        }).sum(d => d.value),
        'dutiesChart',
    );
    makeTreeMap(
        d3.hierarchy(
            d3.group(
                extractData(
                    'hosts',
                    (cols) => {
                        return {
                            label: cols[1].textContent.trim(),
                            world: cols[0].textContent.trim(),
                            value: Number(cols[2].textContent.trim()),
                        };
                    },
                ),
                d => d.world,
            )
        ).sum(d => d.value),
        'hostsChart',
        {
            drawLabels: false,
            grouped: true,
        },
    );
    makeBarPlot(
        extractData('hours'),
        'hoursChart',
        { colorScale: 'sequential' },
    );
    makeBarPlot(
        extractData('days'),
        'daysChart',
    );
})();
