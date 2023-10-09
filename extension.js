const GETTEXT_DOMAIN = 'my-multicore-indicator-extension';

const { GObject, St } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;

const {
    gettext: _,
} = ExtensionUtils;
const PI = 3.141592654;

const COLOR_BACKGROUND = parseColor('#000000');
const CORE_COLORS = [
    parseColor('#E03D45'), // grapefruit
    parseColor('#F18A00'), // tangerine
    parseColor('#F3FF72'), // pastel yellow
    parseColor('#EAF6B7'), // cream
    parseColor('#00AA1F'), // green
    parseColor('#1564C0'), // cornflower blue
    parseColor('#9C42BA'), // purply
    parseColor('#F85C51'), // coral
    parseColor('#D3E379'), // greenish beige
    parseColor('#E3E3E3'), // pale grey
    parseColor('#FF8BA0'), // rose pink
    parseColor('#54BD6C'), // dark mint
    parseColor('#5BD8D2'), // topaz
    parseColor('#F2D868'), // pale gold
    parseColor('#134D30'), // evergreen
    parseColor('#33008E'), // indigo
];
const COLOR_MEM_USED = parseColor('#E3E3E3');
const COLOR_MEM_CACHED = parseColor('#FFCB85');
const COLOR_MEM_BUFFERS = parseColor('#767676');
const COLOR_MEM_DIRTY = parseColor('#E03D45');
const COLOR_SWAP = parseColor('#1F4130');

const STAT_REFRESH_INTERVAL = 1500; // in milliseconds
const CPU_GRAPH_WIDTH = 48;
const MEMORY_GRAPH_WIDTH = 40;
const MEMORY_PIE_ORIENTATION = 0;
const DEBUG = false;

let cpuUsage = []; // first line represents the total CPU usage, next - consecutive cores

function getCurrentCpuUsage() {
    const file = "/proc/stat";
    const contents = GLib.file_get_contents(file);
    if (!contents[0]) {
        return [];
    }
    const content = new TextDecoder().decode(contents[1]);
    const lines = content.split('\n');
    // first line represents the total CPU usage
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const core = i - 1;
        if (line.startsWith("cpu")) {
            const parts = line.split(/\s+/);
            if (parts.length >= 11) {
                const user = parseInt(parts[1]);
                const nice = parseInt(parts[2]);
                const system = parseInt(parts[3]);
                const idle = parseInt(parts[4]);
                const iowait = parseInt(parts[5]);
                const irq = parseInt(parts[6]);
                const softirq = parseInt(parts[7]);
                const steal = parseInt(parts[8]);
                const guest = parseInt(parts[9]);
                const guest_nice = parseInt(parts[10]);

                const total = user + nice + system + idle + iowait + irq + softirq + steal + guest + guest_nice;
                const busyTime = user + nice + system + irq + softirq + steal + guest + guest_nice;

                const busyDelta = busyTime - (cpuUsage[core]?.busyTime || 0);
                const totalDelta = total - (cpuUsage[core]?.total || 0);
                const usage = totalDelta > 0 ? (busyDelta / totalDelta) : 0;
                cpuUsage[core] = {
                    busyTime: busyTime,
                    total: total,
                    usage: usage,
                };
            }
        }
    }
    return cpuUsage;
}

function getCurrentMemoryStats() {
    const file = "/proc/meminfo";
    const contents = GLib.file_get_contents(file);
    if (!contents[0]) {
        return {};
    }
    const content = new TextDecoder().decode(contents[1]);
    const lines = content.split('\n');
    let memoryStats = {};

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const parts = line.split(/\s+/);
        if (parts.length === 3) {
            const key = parts[0].replace(":", "");
            const value = parseInt(parts[1], 10);
            memoryStats[key] = value; // in kilobytes
        }
    }

    const total = memoryStats["MemTotal"];
    const used = total - memoryStats["MemAvailable"];
    const swapUsed = memoryStats["SwapTotal"] - memoryStats["SwapFree"];
    const swapUsage = swapUsed / memoryStats["SwapTotal"];
    return {
        total: total,
        free: memoryStats["MemFree"],
        buffers: memoryStats["Buffers"],
        cached: memoryStats["Cached"],
        used: used,
        usage: used / total,
        available: memoryStats["MemAvailable"],
        dirty: memoryStats["Dirty"],
        writeback: memoryStats["Writeback"],
        dirtyWriteback: memoryStats["Dirty"] + memoryStats["Writeback"],
        swapFree: memoryStats["SwapFree"],
        swapTotal: memoryStats["SwapTotal"],
        swapUsed: swapUsed,
        swapUsage: swapUsage,
    };
}

function formatBytes(kbs) {
    if (kbs < 1024) {
        return `${kbs} KiB`
    } else if (kbs < 1024*1024) {
        return `${(kbs/1024).toFixed(2)} MiB`
    } else {
        return `${(kbs/1024/1024).toFixed(2)} GiB`
    }
}

function parseColor(hashString) {
    return Clutter.Color.from_string(hashString)[1];
}

class Extension {
    constructor(uuid) {
        this._uuid = uuid;
        this.memStats = {};
        ExtensionUtils.initTranslations(GETTEXT_DOMAIN);
    }

    enable() {
        log('Enabling multicore system monitor.');
        this._indicator = new PanelMenu.Button(0.0, Me.metadata.name, false);
        
        this.area = new St.DrawingArea({
            reactive: false,
            width: CPU_GRAPH_WIDTH + MEMORY_GRAPH_WIDTH,
            height: 100,
            style_class: 'graph-drawing-area',
        });
        this.area.connect('repaint', this._draw.bind(this));
        this.timeout = Mainloop.timeout_add(STAT_REFRESH_INTERVAL, this.periodicUpdate.bind(this));
        
        let menuBox = new St.BoxLayout({ vertical: true });
        this.dynamicLabel = new St.Label({ text: "" });
        menuBox.add(this.dynamicLabel);
        let menuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        menuItem.actor.add_actor(menuBox);
        
        this._indicator.menu.addMenuItem(menuItem);
        
        this._indicator.add_child(this.area);
        Main.panel.addToStatusArea(Me.metadata.uuid, this._indicator);
    }

    _draw() {
        let [totalWidth, h] = this.area.get_surface_size();
        let cr = this.area.get_context();
        // clear background
        Clutter.cairo_set_source_color(cr, COLOR_BACKGROUND);
        cr.rectangle(0, 0, totalWidth, h);
        cr.fill();

        this._drawCpu(cr, 0, 0, CPU_GRAPH_WIDTH, h);
        if (this.memStats.used) {
            this._drawMemory(cr, CPU_GRAPH_WIDTH, 0, MEMORY_GRAPH_WIDTH, h);
        }

        cr.$dispose();
    }

    _drawCpu(cr, xOffset, yOffset, w, h) {
        const cores = cpuUsage.length - 1;
        const binW = w / cores;
        for (let core = 0; core < cores; core++) {
            const usage = cpuUsage[core + 1].usage;
            const colorIndex = core % CORE_COLORS.length;
            Clutter.cairo_set_source_color(cr, CORE_COLORS[colorIndex]);
            cr.rectangle(xOffset + core * binW, yOffset + h * (1 - usage), binW, h * usage);
            cr.fill();
        }
    }

    _drawMemory(cr, xOffset, yOffset, w, h) {
        // Swap fill
        Clutter.cairo_set_source_color(cr, COLOR_SWAP);
        const swapUsage = this.memStats.swapUsage || 0;
        cr.rectangle(xOffset, yOffset + h * (1 - swapUsage), w, h * swapUsage);
        cr.fill();

        const centerX = xOffset + w/2;
        const centerY = yOffset + h/2;
        const radius = h/2;
        let angle = 0;
        
        cr.lineWidth = 3;
        const totalMem = this.memStats.total;
        Clutter.cairo_set_source_color(cr, COLOR_MEM_USED);
        angle = this._drawMemoryPiece(cr, centerX, centerY, radius, angle, this.memStats.used / totalMem);
        Clutter.cairo_set_source_color(cr, COLOR_MEM_CACHED);
        angle = this._drawMemoryPiece(cr, centerX, centerY, radius, angle, this.memStats.cached / totalMem);
        Clutter.cairo_set_source_color(cr, COLOR_MEM_BUFFERS);
        angle = this._drawMemoryPiece(cr, centerX, centerY, radius, angle, this.memStats.buffers / totalMem);
        Clutter.cairo_set_source_color(cr, COLOR_MEM_DIRTY);
        angle = this._drawMemoryPiece(cr, centerX, centerY, radius, angle, this.memStats.dirtyWriteback / totalMem);
        cr.lineWidth = 1;
    }

    _drawMemoryPiece(cr, centerX, centerY, radius, startFraction, fraction) {
        const startAngle = (startFraction + MEMORY_PIE_ORIENTATION) * 2 * PI;
        const endAngle = startAngle + fraction * 2 * PI;
        cr.moveTo(centerX, centerY);
        cr.arc(centerX, centerY, radius, startAngle, endAngle);
        cr.lineTo(centerX, centerY);
        cr.fill();
        return startFraction + fraction;
    }

    periodicUpdate() {
        getCurrentCpuUsage();
        this.memStats = getCurrentMemoryStats();
        this.dynamicLabel.text = this.buildIndicatorLabel();
        if (DEBUG) {
            for (let i = 0; i < cpuUsage.length - 1; i++) {
                log(`CPU Core ${i} usage: ${cpuUsage[i + 1].usage.toFixed(2)}`);
            }
            log('Memory stats', Object.entries(this.memStats));
        }
        this.area.queue_repaint();
        return true; // Return true to keep the timeout running
    }

    buildIndicatorLabel() {
        const lines = [];
        if (cpuUsage.length > 0) {
            const totalUsage = cpuUsage[0].usage * 100
            lines.push(`CPU usage: ${totalUsage.toFixed(2)}%`);
        }
        if (this.memStats.used) {
            const percentUsage = (this.memStats.usage * 100).toFixed(2);
            const swapUsage = (this.memStats.swapUsage * 100).toFixed(2);
            lines.push(`Memory usage: ${formatBytes(this.memStats.used)} / ${formatBytes(this.memStats.total)} (${percentUsage}%)`);
            lines.push(`Cached: ${formatBytes(this.memStats.cached)}`);
            lines.push(`Buffers: ${formatBytes(this.memStats.buffers)}`);
            lines.push(`Dirty / Writeback: ${formatBytes(this.memStats.dirtyWriteback)}`);
            lines.push(`Swap: ${formatBytes(this.memStats.swapUsed)} / ${formatBytes(this.memStats.swapTotal)} (${swapUsage}%)`);
        }
        return lines.join("\n");
    }

    destroy() {
        if (this.timeout) {
            log('Multicore: Disabling periodic refresh')
            Mainloop.source_remove(this.timeout);
            this.timeout = null;
        }
    }

    disable() {
        this.destroy()
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}

function init(meta) {
    return new Extension(meta.uuid);
}
