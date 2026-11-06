package com.example.pocketnotes;

import android.content.ContentProvider;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.UriMatcher;
import android.database.Cursor;
import android.net.Uri;

/** Notes shared with other apps: content://com.example.pocketnotes.provider/notes[/id]. */
public class NotesProvider extends ContentProvider {
    static final String AUTHORITY = "com.example.pocketnotes.provider";
    private static final int NOTES = 1;
    private static final int NOTE_ID = 2;
    private static final UriMatcher MATCHER = new UriMatcher(UriMatcher.NO_MATCH);

    static {
        MATCHER.addURI(AUTHORITY, "notes", NOTES);
        MATCHER.addURI(AUTHORITY, "notes/#", NOTE_ID);
    }

    private NotesDb db;

    @Override
    public boolean onCreate() {
        db = new NotesDb(getContext());
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        switch (MATCHER.match(uri)) {
            case NOTES:
                return db.getReadableDatabase().query(NotesDb.TABLE, projection, selection, selectionArgs, null, null, sortOrder == null ? "_id DESC" : sortOrder);
            case NOTE_ID:
                return db.getReadableDatabase().query(NotesDb.TABLE, projection, "_id=?", new String[] {String.valueOf(ContentUris.parseId(uri))}, null, null, null);
            default:
                throw new IllegalArgumentException("Unknown URI " + uri);
        }
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        if (MATCHER.match(uri) != NOTES) throw new IllegalArgumentException("Unknown URI " + uri);
        if (values == null || !values.containsKey("title")) throw new IllegalArgumentException("title is required");
        long id = db.getWritableDatabase().insert(NotesDb.TABLE, null, values);
        return ContentUris.withAppendedId(uri, id);
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        if (MATCHER.match(uri) != NOTE_ID) throw new IllegalArgumentException("Delete one note by id: " + uri);
        return db.getWritableDatabase().delete(NotesDb.TABLE, "_id=?", new String[] {String.valueOf(ContentUris.parseId(uri))});
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        if (MATCHER.match(uri) != NOTE_ID) throw new IllegalArgumentException("Update one note by id: " + uri);
        return db.getWritableDatabase().update(NotesDb.TABLE, values, "_id=?", new String[] {String.valueOf(ContentUris.parseId(uri))});
    }

    @Override
    public String getType(Uri uri) {
        return MATCHER.match(uri) == NOTE_ID ? "vnd.android.cursor.item/vnd.pocketnotes.note" : "vnd.android.cursor.dir/vnd.pocketnotes.note";
    }
}
