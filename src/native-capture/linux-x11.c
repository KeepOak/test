/* Prepared X11 helper. Only XComposite window pixmaps are read; never the root drawable. */
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/Xatom.h>
#include <X11/extensions/Xcomposite.h>
#include <json-c/json.h>
#include <png.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <fcntl.h>
#include <unistd.h>
static Display *display;
static int fault;
static int xerror(Display *d, XErrorEvent *e) { (void)d; (void)e; fault = 1; return 0; }
static void refuse(const char *message) { fprintf(stderr, "Native capture refused: %s", message); if (display) XCloseDisplay(display); exit(1); }
static json_object *field(json_object *o, const char *key) { json_object *v = NULL; if (!o || !json_object_object_get_ex(o, key, &v)) refuse("Missing exact terms"); return v; }
static const char *text(json_object *o, const char *key) { json_object *v = field(o, key); if (!json_object_is_type(v, json_type_string)) refuse("String required"); return json_object_get_string(v); }
static unsigned char *property(Window w, const char *name, Atom type, int format, unsigned long *count) {
    Atom actual; int bits; unsigned long remaining; unsigned char *data = NULL;
    if (XGetWindowProperty(display, w, XInternAtom(display, name, False), 0, 4096, False, type, &actual, &bits, count, &remaining, &data) != Success || actual != type || bits != format || remaining) { if (data) XFree(data); return NULL; }
    return data;
}
static json_object *describe(Window w) {
    XWindowAttributes a; fault = 0;
    if (!XGetWindowAttributes(display, w, &a) || a.map_state != IsViewable || a.width < 1 || a.height < 1 || a.width > 8192 || a.height > 8192) return NULL;
    unsigned long count = 0; unsigned char *pid = property(w, "_NET_WM_PID", XA_CARDINAL, 32, &count);
    if (!pid || count != 1 || !*(unsigned long *)pid) { if (pid) XFree(pid); return NULL; }
    long process = (long)*(unsigned long *)pid; XFree(pid);
    unsigned char *title = property(w, "_NET_WM_NAME", XInternAtom(display, "UTF8_STRING", False), 8, &count);
    if (!title || count > 1000) { if (title) XFree(title); return NULL; }
    int x, y; Window child; if (!XTranslateCoordinates(display, w, DefaultRootWindow(display), 0, 0, &x, &y, &child)) { XFree(title); return NULL; }
    XClassHint cls = {0}; XGetClassHint(display, w, &cls); XSync(display, False);
    if (fault || (cls.res_class && strlen(cls.res_class) > 500)) { XFree(title); if (cls.res_name) XFree(cls.res_name); if (cls.res_class) XFree(cls.res_class); return NULL; }
    char id[32]; snprintf(id, sizeof(id), "%lu", w); json_object *o = json_object_new_object(), *bounds = json_object_new_object();
    json_object_object_add(o, "id", json_object_new_string(id)); json_object_object_add(o, "pid", json_object_new_int64(process));
    json_object_object_add(o, "title", json_object_new_string_len((char *)title, (int)count)); json_object_object_add(o, "program", json_object_new_string(cls.res_class ? cls.res_class : ""));
    json_object_object_add(bounds, "x", json_object_new_int(x)); json_object_object_add(bounds, "y", json_object_new_int(y));
    json_object_object_add(bounds, "w", json_object_new_int(a.width)); json_object_object_add(bounds, "h", json_object_new_int(a.height)); json_object_object_add(o, "bounds", bounds);
    XFree(title); if (cls.res_name) XFree(cls.res_name); if (cls.res_class) XFree(cls.res_class); return o;
}
static json_object *windows(void) {
    unsigned long count = 0; unsigned char *data = property(DefaultRootWindow(display), "_NET_CLIENT_LIST", XA_WINDOW, 32, &count);
    if (!data || count > 2048) { if (data) XFree(data); refuse("EWMH window discovery unavailable or too large"); }
    json_object *rows = json_object_new_array(); unsigned long *ids = (unsigned long *)data;
    for (unsigned long i = 0; i < count; i++) { json_object *row = describe(ids[i]); if (row) json_object_array_add(rows, row); }
    XFree(data); return rows;
}
static Window exact(json_object *wanted) {
    const char *id = text(wanted, "id"); char *end; unsigned long parsed = strtoul(id, &end, 10);
    if (!parsed || *end || parsed == DefaultRootWindow(display)) refuse("Invalid window ID");
    json_object *current = describe(parsed); int same = current && json_object_equal(current, wanted); if (current) json_object_put(current);
    if (!same) refuse("Window closed, moved, resized or changed identity; discover again"); return parsed;
}
static unsigned char component(unsigned long pixel, unsigned long mask) {
    if (!mask) return 0; unsigned int shift = 0; while (!(mask & 1)) { mask >>= 1; shift++; }
    return (unsigned char)(((pixel >> shift) & mask) * 255 / mask);
}
static void write_png(const char *path, XImage *image) {
    if (path[0] != '/' || strlen(path) > 4096) refuse("Private absolute output path required");
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600); if (fd < 0) refuse("Cannot create private PNG");
    FILE *file = fdopen(fd, "wb"); if (!file) { close(fd); refuse("Cannot open PNG stream"); }
    png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL); png_infop info = png ? png_create_info_struct(png) : NULL;
    if (!png || !info || setjmp(png_jmpbuf(png))) { if (png) png_destroy_write_struct(&png, &info); fclose(file); unlink(path); refuse("PNG encoding failed"); }
    png_init_io(png, file); png_set_IHDR(png, info, image->width, image->height, 8, PNG_COLOR_TYPE_RGB, PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT); png_write_info(png, info);
    unsigned char *row = malloc((size_t)image->width * 3); if (!row) refuse("PNG row allocation failed");
    for (int y = 0; y < image->height; y++) { for (int x = 0; x < image->width; x++) { unsigned long pixel = XGetPixel(image, x, y); row[x * 3] = component(pixel, image->red_mask); row[x * 3 + 1] = component(pixel, image->green_mask); row[x * 3 + 2] = component(pixel, image->blue_mask); } png_write_row(png, row); }
    free(row); png_write_end(png, info); png_destroy_write_struct(&png, &info); fclose(file);
}
static void capture(json_object *request, json_object *reply) {
    json_object *target = field(request, "target"), *exclude = field(request, "exclude");
    if (strcmp(text(target, "kind"), "window") || !json_object_is_type(exclude, json_type_array) || json_object_array_length(exclude)) refuse("X11 display-window exclusion unsupported; window-only capture required");
    json_object *wanted = field(target, "window"); Window w = exact(wanted); json_object *bounds = field(wanted, "bounds");
    int width = json_object_get_int(field(bounds, "w")), height = json_object_get_int(field(bounds, "h"));
    if (width < 1 || height < 1 || (int64_t)width * height > 16000000) refuse("Pixel bound exceeded");
    int major = 0, minor = 0; if (!XCompositeQueryVersion(display, &major, &minor) || (major == 0 && minor < 2)) refuse("XComposite 0.2+ unavailable");
    XWindowAttributes attributes; if (!XGetWindowAttributes(display, w, &attributes) || attributes.visual->class != TrueColor) refuse("TrueColor window required");
    fault = 0; XCompositeRedirectWindow(display, w, CompositeRedirectAutomatic); XSync(display, False); if (fault) refuse("Window redirection unavailable");
    Pixmap pixmap = XCompositeNameWindowPixmap(display, w); XSync(display, False); if (fault || !pixmap) refuse("Window pixmap unavailable; no screen fallback");
    XImage *image = XGetImage(display, pixmap, 0, 0, width, height, AllPlanes, ZPixmap); XSync(display, False);
    if (!image || fault) refuse("Unsupported native window pixels");
    image->red_mask = attributes.visual->red_mask; image->green_mask = attributes.visual->green_mask; image->blue_mask = attributes.visual->blue_mask;
    if (!image->red_mask || !image->green_mask || !image->blue_mask) refuse("Unsupported colour masks");
    exact(wanted); json_object *after = windows(); exact(wanted);
    write_png(text(request, "outPath"), image); XDestroyImage(image); XFreePixmap(display, pixmap); XCompositeUnredirectWindow(display, w, CompositeRedirectAutomatic);
    json_object_object_add(reply, "before", json_object_get(field(reply, "windows"))); json_object_object_add(reply, "windows", after);
    json_object_object_add(reply, "width", json_object_new_int(width)); json_object_object_add(reply, "height", json_object_new_int(height));
    json_object_object_add(reply, "method", json_object_new_string("native-window")); json_object_object_add(reply, "target", json_object_get(target)); json_object_object_add(reply, "exclude", json_object_get(exclude));
}
int main(int argc, char **argv) {
    if (argc != 2 || strlen(argv[1]) > 100000) refuse("Bounded JSON request required");
    if (getenv("WAYLAND_DISPLAY") || (getenv("XDG_SESSION_TYPE") && !strcmp(getenv("XDG_SESSION_TYPE"), "wayland"))) refuse("Wayland unsupported");
    json_object *request = json_tokener_parse(argv[1]); if (!request) refuse("Invalid JSON");
    display = XOpenDisplay(NULL); if (!display) refuse("No X11 display"); XSetErrorHandler(xerror);
    json_object *reply = json_object_new_object(); json_object_object_add(reply, "protocol", json_object_new_int(1)); json_object_object_add(reply, "platform", json_object_new_string("x11"));
    json_object_object_add(reply, "windows", windows()); json_object_object_add(reply, "displays", json_object_new_array());
    const char *action = text(request, "action"); if (!strcmp(action, "capture")) capture(request, reply); else if (strcmp(action, "list")) refuse("Unknown action");
    puts(json_object_to_json_string_ext(reply, JSON_C_TO_STRING_PLAIN)); json_object_put(reply); json_object_put(request); XCloseDisplay(display); return 0;
}