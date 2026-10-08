package com.umolk.term.adapters;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.TextView;
import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;
import com.umolk.term.R;
import com.umolk.term.models.Snippet;
import java.util.List;

public class SnippetAdapter extends RecyclerView.Adapter<SnippetAdapter.SnippetViewHolder> {

    public interface OnSnippetClickListener {
        void onRun(Snippet snippet);
        void onInsert(Snippet snippet);
        void onDelete(Snippet snippet);
    }

    private List<Snippet> snippetList;
    private OnSnippetClickListener listener;

    public SnippetAdapter(List<Snippet> snippetList, OnSnippetClickListener listener) {
        this.snippetList = snippetList;
        this.listener = listener;
    }

    @NonNull
    @Override
    public SnippetViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_snippet_card, parent, false);
        return new SnippetViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull SnippetViewHolder holder, int position) {
        Snippet snippet = snippetList.get(position);
        holder.tvSnippetTitle.setText(snippet.getTitle());
        holder.tvSnippetGroup.setText(snippet.getGroup());
        holder.tvSnippetCommand.setText(snippet.getCommand());

        holder.btnRun.setOnClickListener(v -> listener.onRun(snippet));
        holder.btnInsert.setOnClickListener(v -> listener.onInsert(snippet));
        holder.btnDelete.setOnClickListener(v -> listener.onDelete(snippet));
    }

    @Override
    public int getItemCount() {
        return snippetList != null ? snippetList.size() : 0;
    }

    static class SnippetViewHolder extends RecyclerView.ViewHolder {
        TextView tvSnippetGroup, tvSnippetTitle, tvSnippetCommand;
        Button btnRun, btnInsert, btnDelete;

        public SnippetViewHolder(@NonNull View itemView) {
            super(itemView);
            tvSnippetGroup = itemView.findViewById(R.id.tvSnippetGroup);
            tvSnippetTitle = itemView.findViewById(R.id.tvSnippetTitle);
            tvSnippetCommand = itemView.findViewById(R.id.tvSnippetCommand);
            btnRun = itemView.findViewById(R.id.btnRunSnippet);
            btnInsert = itemView.findViewById(R.id.btnInsertSnippet);
            btnDelete = itemView.findViewById(R.id.btnDeleteSnippet);
        }
    }
}
