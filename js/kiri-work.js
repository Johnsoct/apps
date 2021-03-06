/** Copyright 2014-2017 Stewart Allen -- All Rights Reserved */

if (self.window) {

    if (!self.kiri) self.kiri = {};

    var loc = self.location,
        host = loc.hostname,
        port = loc.port,
        proto = loc.protocol,
        pre = host.indexOf(".space") > 0 || host === "localhost" ?
            proto + "//" + host + ":" + port :
            "",
        time = function() { return new Date().getTime() },
        KIRI = self.kiri,
        BASE = self.base,
        seqid = 1,
        running = {},
        worker = new Worker(pre + "/code/worker.js/" + exports.VERSION);

    // new moto.Ajax(function(body) {
    //     console.log({body:body});
    //     var blob = new Blob([body], {type : 'application/json'});
    //     worker = new Worker(URL.createObjectURL(blob));
    // }).request(pre + "/code/worker.js/");

    worker.onmessage = function(e) {
        var now = time(),
            reply = e.data,
            record = running[reply.seq],
            onreply = record.fn;

        if (reply.done) delete running[reply.seq];

        // calculate and replace recv time
        reply.time_recv = now - reply.time_recv;

        onreply(reply.data, reply);
    };

    function send(fn, data, onreply, async, zerocopy) {
        var seq = seqid++;

        running[seq] = {fn:onreply, async:async||false};

        worker.postMessage({
            seq: seq,
            task: fn,
            time: time(),
            data: data
        }, zerocopy);
    }

    KIRI.work = {
        decimate : function(vertices, callback) {
            var vertices = vertices.buffer.slice(0);
            send("decimate", vertices, function(output) {
                callback(output);
            });
        },

        clear : function(widget) {
            send("clear", widget ? {id:widget.id} : {}, function(reply) {
                // console.log({clear:reply});
            });
        },

        cancel : function(widget) {
            send("cancel", widget ? {id:widget.id} : {});
        },

        slice : function(settings, widget, callback) {
            var vertices = widget.getGeoVertices().buffer.slice(0);
            send("slice", {
                id: widget.id,
                settings: settings,
                vertices: vertices,
                position: widget.mesh.position
            }, function(reply) {
                callback(reply);
            }, null, [vertices]);
        },

        printSetup : function(settings, callback) {
            send("printSetup", {settings:settings}, function(reply) {
                callback(reply);
            });
        },

        printGCode : function(callback) {
            var gcode = [],
                start = BASE.util.time();
            send("printGCode", {}, function(reply) {
                if (reply.line) {
                    gcode.push(reply.line);
                } else {
                    if (!reply.gcode) reply.gcode = gcode.join("\n");
                    // console.log({printGCode:(BASE.util.time() - start)});
                    callback(reply);
                }
            });
        },

        sliceToGCode : function(settings, vertices, callback) {
            var wid = new Date().toString(36);
            var vertices = widget.getGeoVertices().buffer.slice(0);
            send("slice", {settings:settings, id:wiwd, vertices:vertices, position:{x:0,y:0,z:0}}, function(reply) {
                send("printSetup", {settings:settings}, function(reply) {
                    send("printGCode", {}, function(reply) {
                        callback(reply);
                    });
                }, null, [vertices]);
                callback(reply);
            });
        }
    };

} else {
    module = { exports: {} };

    var loc = self.location,
        host = loc.hostname,
        ver = exports.VERSION,
        time = function() { return new Date().getTime() };

    console.log("kiri | init work | " + ver);

    // when running the server in 'web' mode, the obfuscated code is served as a
    // unified ball via /code/work.js -- otherwise, map "localhost" to "debug"
    // to debug unobfuscated code.  if not, /js/ paths will 404.
    if (host !== 'grid.space' && host !== 'debug') {
        [
            "license","ext-n3d","ext-clip","add-array",
            "add-three","geo","geo-point","geo-debug","geo-bounds",
            "geo-line","geo-slope","geo-polygon","geo-polygons",
            "kiri-slice","kiri-slicer","kiri-driver-fdm","kiri-driver-cam",
            "kiri-driver-laser","kiri-widget","kiri-pack","kiri-print","kiri-codec"
        ].forEach(function(scr) {
            importScripts(["/js/",scr,".js","/v"+ver].join(''));
        })
    } else {
        importScripts("/code/work.js/"+ver);
        base.debug.disable();
    }

    var base = self.base,
        moto = self.moto,
        dbug = base.debug,
        util = base.util,
        kiri = self.kiri,
        Widget = kiri.Widget,
        currentPrint,
        cache = {};

    var dispatch = {
        decimate: function(vertices, send) {
            vertices = new Float32Array(vertices),
            vertices = Widget.pointsToVertices(Widget.verticesToPoints(vertices, true));
            send.done(vertices);
        },

        cancel: function(data) {
            if (data.id) {
                var widget = cache[data.id];
                if (widget) widget.cancel = true;
            } else {
                for (var id in cache) {
                    if (cache.hasOwnProperty(id)) cache[id].cancel = true;
                }
            }
        },

        slice: function(data, send) {
            var settings = data.settings,
                vertices = new Float32Array(data.vertices),
                position = data.position,
                points = Widget.verticesToPoints(vertices);

            send.data({update:0.05, updateStatus:"slicing"});

            var widget = kiri.newWidget(data.id).setPoints(points),
                last = util.time(),
                now;

            // clear previous widget data before reslice
            delete cache[data.id];

            // fake mesh object to satisfy printing
            widget.mesh = {
                widget: widget,
                position: position
            };

            widget.slice(settings, function() {
                send.data({send_start:time()});
                send.data({
                    topo: settings.synth.sendTopo ? widget.topo : null,
                    stats: widget.stats,
                    slices: widget.slices.length
                });
                widget.slices.forEach(function(slice,index) {
                    send.data({index:index, slice:slice.encode()});
                })
                send.data({send_end:time()});
                send.done({done:true});
                // cache results for future printing
                cache[data.id] = widget;
            }, function(update, msg) {
                now = util.time();
                if (now - last < 10 && update < 0.99) return;
                // on update
                send.data({update:(0.05 + update * 0.95), updateStatus:msg});
                last = now;
            });
        },

        printSetup: function(data, send) {
            var widgets = [], key;
            for (key in cache) {
                if (cache.hasOwnProperty(key)) widgets.push(cache[key]);
            }

            send.data({update:0.05, updateStatus:"preview"});

            currentPrint = kiri.newPrint(data.settings, widgets, data.id);
            currentPrint.setup(false, function(update, msg) {
                send.data({
                    update: update,
                    updateStatus: msg
                });
            }, function() {
                send.done({
                    done: true,
                    output: currentPrint.encodeOutput()
                });
            });
        },

        printGCode: function(data, send) {
            currentPrint.exportGCode(false, function(gcode) {
                send.done({
                    gcode: gcode,
                    lines: currentPrint.lines,
                    bytes: currentPrint.bytes,
                    bounds: currentPrint.bounds,
                    distance: currentPrint.distance,
                    time: currentPrint.time
                });
            }, function(line) {
                send.data({line:line});
            });
        },

        clear: function(data, send) {
            if (!data.id) {
                cache = {};
                currentPrint = null;
                send.done({ clear: true });
                return;
            }
            var had = cache[data.id] !== undefined;
            delete cache[data.id];
            send.done({
                id: data.id,
                had: had,
                has: cache[data.id] !== undefined
            });
        },
    };

    self.onmessage = function(e) {
        var time_recv = util.time(),
            msg = e.data,
            run = dispatch[msg.task],
            send = {
                data : function(data,direct) {
                    self.postMessage({
                        seq: msg.seq,
                        task: msg.task,
                        done: false,
                        data: data
                    },direct);
                },
                done : function(data,direct) {
                    self.postMessage({
                        seq: msg.seq,
                        task: msg.task,
                        done: true,
                        data: data
                    },direct);
                }
            };

        if (run) {
            var time_xfer = (time_recv - msg.time),
                output = run(msg.data, send),
                time_send = util.time(),
                time_proc = time_send - time_recv;

            if (output) self.postMessage({
                seq: msg.seq,
                task: msg.task,
                time_send: time_xfer,
                time_proc: time_proc,
                // replaced on reply side
                time_recv: util.time(),
                data: output
            });
        } else {
            console.log({kiri_msg:e});
        }
    };

    // catch clipper alerts and convert to console messages
    self.alert = function(o) {
        console.log(o);
    };

}
