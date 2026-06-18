module JuliaVSCodeProfiler

using Profile
using Sockets

export @profview, @profview_allocs, view_profile, view_profile_allocs

const conn = Ref{Union{Nothing,IO}}(nothing)
const session_id = Ref("")
const session_name = Ref("")
const send_lock = ReentrantLock()

mutable struct ProfileFrame
    func::String
    file::String
    path::String
    line::Int
    count::Int
    countLabel::Any
    flags::UInt8
    taskId::Any
    children::Vector{ProfileFrame}
end

const ProfileFrameFlag = (
    RuntimeDispatch = UInt8(2^0),
    GCEvent = UInt8(2^1),
    REPL = UInt8(2^2),
    Compilation = UInt8(2^3),
    TaskEvent = UInt8(2^4),
)

function json_escape(io::IO, s::AbstractString)
    write(io, '"')
    for c in s
        if c == '"'
            write(io, "\\\"")
        elseif c == '\\'
            write(io, "\\\\")
        elseif c == '\b'
            write(io, "\\b")
        elseif c == '\f'
            write(io, "\\f")
        elseif c == '\n'
            write(io, "\\n")
        elseif c == '\r'
            write(io, "\\r")
        elseif c == '\t'
            write(io, "\\t")
        elseif c < ' '
            write(io, "\\u", lpad(string(Int(c), base=16), 4, '0'))
        else
            write(io, c)
        end
    end
    write(io, '"')
end

function json_write(io::IO, value)
    if value === nothing || value === missing
        write(io, "null")
    elseif value isa AbstractString
        json_escape(io, value)
    elseif value isa Bool
        write(io, value ? "true" : "false")
    elseif value isa Integer
        write(io, string(value))
    elseif value isa AbstractFloat
        if isfinite(value)
            write(io, string(value))
        else
            write(io, "null")
        end
    elseif value isa ProfileFrame
        json_write_profile_frame(io, value)
    elseif value isa AbstractDict
        write(io, '{')
        first = true
        for (k, v) in value
            first || write(io, ',')
            first = false
            json_escape(io, string(k))
            write(io, ':')
            json_write(io, v)
        end
        write(io, '}')
    elseif value isa AbstractVector || value isa Tuple
        write(io, '[')
        first = true
        for item in value
            first || write(io, ',')
            first = false
            json_write(io, item)
        end
        write(io, ']')
    else
        json_escape(io, string(value))
    end
end

function json_pair(io::IO, key::AbstractString, value, isfirst::Bool)
    isfirst || write(io, ',')
    json_escape(io, key)
    write(io, ':')
    json_write(io, value)
    return false
end

function json_write_profile_frame(io::IO, frame::ProfileFrame)
    write(io, '{')
    first = true
    first = json_pair(io, "func", frame.func, first)
    first = json_pair(io, "file", frame.file, first)
    first = json_pair(io, "path", frame.path, first)
    first = json_pair(io, "line", frame.line, first)
    first = json_pair(io, "count", frame.count, first)
    first = json_pair(io, "countLabel", frame.countLabel, first)
    first = json_pair(io, "flags", frame.flags, first)
    first = json_pair(io, "taskId", frame.taskId, first)
    json_pair(io, "children", frame.children, first)
    write(io, '}')
end

function json(value)
    io = IOBuffer()
    json_write(io, value)
    return String(take!(io))
end

function send_event(type::AbstractString; data=nothing, profile_type=nothing, message=nothing)
    io = conn[]
    if io === nothing
        @warn "Julia is not connected to VS Code; cannot send $type event."
        return false
    end

    event = Dict{String,Any}(
        "type" => type,
        "sessionId" => session_id[],
        "sessionName" => session_name[],
    )
    data !== nothing && (event["data"] = data)
    profile_type !== nothing && (event["profileType"] = profile_type)
    message !== nothing && (event["message"] = message)

    lock(send_lock)
    try
        write(io, json(event))
        write(io, '\n')
        flush(io)
        return true
    catch err
        @warn "Julia failed to send $type event to VS Code." exception=(err, catch_backtrace())
        return false
    finally
        unlock(send_lock)
    end
end

send_warning(message::AbstractString) = send_event("warning"; message=message)

function connect_to_vscode(pipe_name::AbstractString, id::AbstractString, name::AbstractString)
    session_id[] = String(id)
    session_name[] = String(name)
    try
        conn[] = Sockets.connect(pipe_name)
        send_event("connected")
    catch err
        conn[] = nothing
        @warn "Julia could not connect to VS Code." pipe=pipe_name exception=(err, catch_backtrace())
    end
    return nothing
end

function isuntitled(path::AbstractString)
    return occursin(r"Untitled-\d+$", path)
end

function realpath_safe(path::AbstractString)
    try
        return normpath(ispath(path) ? realpath(path) : path)
    catch
        return normpath(path)
    end
end

function fullpath(path)
    p = string(path)
    isempty(p) && return ""
    isuntitled(p) && return p
    candidate = isabspath(p) ? p : normpath(joinpath(Sys.BINDIR, Base.DATAROOTDIR, "julia", "base", p))
    return realpath_safe(candidate)
end

function stackframetree(data_u64, lidict; thread=nothing, combine=true, recur=:off)
    root = combine ? Profile.StackFrameTree{Base.StackTraces.StackFrame}() : Profile.StackFrameTree{UInt64}()
    if VERSION >= v"1.8.0-DEV.460"
        root, _ = Profile.tree!(root, data_u64, lidict, true, recur, thread)
    else
        root = Profile.tree!(root, data_u64, lidict, true, recur)
    end
    if !isempty(root.down)
        root.count = sum(pair -> pair.second.count, root.down)
    end
    return root
end

function status(sf::Base.StackTraces.StackFrame)
    st = UInt8(0)
    func = string(sf.func)
    file = string(sf.file)
    if sf.from_c && (sf.func === :jl_invoke || sf.func === :jl_apply_generic || sf.func === :ijl_apply_generic)
        st |= ProfileFrameFlag.RuntimeDispatch
    end
    if sf.from_c && startswith(func, "jl_gc_")
        st |= ProfileFrameFlag.GCEvent
    end
    if !sf.from_c && sf.func === :eval_user_input && endswith(file, "REPL.jl")
        st |= ProfileFrameFlag.REPL
    end
    if !sf.from_c && occursin("./compiler/", file)
        st |= ProfileFrameFlag.Compilation
    end
    if !sf.from_c && occursin("task.jl", file)
        st |= ProfileFrameFlag.TaskEvent
    end
    return st
end

function status(node::Profile.StackFrameTree, C::Bool)
    st = status(node.frame)
    C && return st
    for child in values(node.down)
        child.frame.from_c || continue
        st |= status(child, C)
    end
    return st
end

function add_child(graph::ProfileFrame, node, C::Bool)
    path = string(node.frame.file)
    func = string(node.frame.func)
    isempty(func) && (func = "unknown")
    frame = ProfileFrame(
        func,
        basename(path),
        fullpath(path),
        Int(node.frame.line),
        Int(node.count),
        missing,
        status(node, C),
        missing,
        ProfileFrame[],
    )
    push!(graph.children, frame)
    return frame
end

function make_tree(graph::ProfileFrame, node::Profile.StackFrameTree; C=false)
    for child_node in sort!(collect(values(node.down)); rev=true, by=n -> n.count)
        if C || !child_node.frame.from_c
            child = add_child(graph, child_node, C)
            make_tree(child, child_node; C=C)
        else
            make_tree(graph, child_node; C=C)
        end
    end
    return graph
end

function thread_ids()
    if VERSION < v"1.8.0-DEV.460"
        return Any[nothing]
    end
    all_tids = if isdefined(Threads, :threadpooltids)
        sort(vcat(collect(Threads.threadpooltids(:interactive)), collect(Threads.threadpooltids(:default))))
    else
        collect(1:Threads.nthreads())
    end
    return Any[nothing; all_tids]
end

function thread_name(thread, max_thread_chars::Int)
    thread === nothing && return "all"
    padding = " "^max(0, max_thread_chars - length(string(thread)))
    if isdefined(Threads, :threadpool)
        return string(padding, thread, " (", Threads.threadpool(thread), ")")
    end
    return string(padding, thread)
end

function view_profile(data = Profile.fetch(), lidict = Profile.getdict(unique(data)); C=false, kwargs...)
    if isempty(data)
        isdefined(Profile, :warning_empty) && Profile.warning_empty()
        send_warning("No CPU profile samples were collected.")
        return nothing
    end

    data_u64 = convert(Vector{UInt64}, data)
    threads = thread_ids()
    numeric_threads = [thread for thread in threads if thread !== nothing]
    max_thread_chars = isempty(numeric_threads) ? 0 : maximum(length.(string.(numeric_threads)))
    roots = Dict{String,ProfileFrame}()

    for thread in threads
        graph = stackframetree(data_u64, lidict; thread=thread, kwargs...)
        roots[thread_name(thread, max_thread_chars)] = make_tree(
            ProfileFrame("root", "", "", 0, Int(graph.count), missing, 0x0, missing, ProfileFrame[]),
            graph;
            C=C,
        )
    end

    send_event("profile"; profile_type="Thread", data=roots)
    return roots
end

function make_keyword_call(name::Symbol, args)
    call = Expr(:call, GlobalRef(@__MODULE__, name))
    if !isempty(args)
        push!(call.args, Expr(:parameters, esc.(args)...))
    end
    return call
end

macro profview(ex, args...)
    view_call = make_keyword_call(:view_profile, args)
    return quote
        Profile.clear()
        Profile.@profile $(esc(ex))
        $view_call
    end
end

macro profview_allocs(ex, args...)
    sample_rate_expr = :(sample_rate = 0.0001)
    view_args = Any[]
    for arg in args
        if Meta.isexpr(arg, :(=)) && !isempty(arg.args) && arg.args[1] === :sample_rate
            sample_rate_expr = arg
        else
            push!(view_args, arg)
        end
    end

    view_call = make_keyword_call(:view_profile_allocs, view_args)
    if isdefined(Profile, :Allocs)
        return quote
            Profile.Allocs.clear()
            Profile.Allocs.@profile $(esc(sample_rate_expr)) $(esc(ex))
            $view_call
        end
    end
    return quote
        @warn "This Julia version does not support allocation profiling."
        JuliaVSCodeProfiler.send_warning("This Julia version does not support allocation profiling.")
        nothing
    end
end

function memory_size(size)
    prefixes = ("bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB")
    value = Float64(size)
    i = 1
    while value > 1000 && i < length(prefixes)
        value /= 1000
        i += 1
    end
    return string(round(Int, value), " ", prefixes[i])
end

function view_profile_allocs(results = nothing; C=false)
    if !isdefined(Profile, :Allocs)
        send_warning("This Julia version does not support allocation profiling.")
        return nothing
    end

    results === nothing && (results = Profile.Allocs.fetch())
    allocs = results.allocs
    allocs_root = ProfileFrame("root", "", "", 0, 0, missing, 0x0, missing, ProfileFrame[])
    counts_root = ProfileFrame("root", "", "", 0, 0, missing, 0x0, missing, ProfileFrame[])

    for alloc in allocs
        this_allocs = allocs_root
        this_counts = counts_root

        for sf in Iterators.reverse(alloc.stacktrace)
            if !C && sf.from_c
                continue
            end
            file = string(sf.file)
            next_counts = ProfileFrame(
                string(sf.func),
                basename(file),
                fullpath(file),
                Int(sf.line),
                0,
                missing,
                0x0,
                missing,
                ProfileFrame[],
            )
            ind = findfirst(
                child -> child.func == next_counts.func && child.path == next_counts.path && child.line == next_counts.line,
                this_allocs.children,
            )

            if ind === nothing
                push!(this_counts.children, next_counts)
                next_allocs = deepcopy(next_counts)
                push!(this_allocs.children, next_allocs)
                this_counts = next_counts
                this_allocs = next_allocs
            else
                this_counts = this_counts.children[ind]
                this_allocs = this_allocs.children[ind]
            end

            this_allocs.count += Int(alloc.size)
            this_allocs.countLabel = memory_size(this_allocs.count)
            this_counts.count += 1
        end

        alloc_type = replace(string(alloc.type), "Profile.Allocs." => "")
        ind = findfirst(child -> child.func == alloc_type, this_allocs.children)
        if ind === nothing
            push!(this_allocs.children, ProfileFrame(
                alloc_type,
                "",
                "",
                0,
                this_allocs.count,
                memory_size(this_allocs.count),
                ProfileFrameFlag.GCEvent,
                missing,
                ProfileFrame[],
            ))
            push!(this_counts.children, ProfileFrame(
                alloc_type,
                "",
                "",
                0,
                1,
                missing,
                ProfileFrameFlag.GCEvent,
                missing,
                ProfileFrame[],
            ))
        else
            this_counts.children[ind].count += 1
            this_allocs.children[ind].count += Int(alloc.size)
            this_allocs.children[ind].countLabel = memory_size(this_allocs.children[ind].count)
        end

        counts_root.count += 1
        allocs_root.count += Int(alloc.size)
        allocs_root.countLabel = memory_size(allocs_root.count)
    end

    roots = Dict{String,ProfileFrame}(
        "size" => allocs_root,
        "count" => counts_root,
    )
    send_event("profile"; profile_type="Allocation", data=roots)
    return roots
end

function install_names()
    Core.eval(Main, :(using .JuliaVSCodeProfiler: @profview, @profview_allocs, view_profile, view_profile_allocs))
    return nothing
end

end # module

if length(ARGS) >= 3
    pipe_name = popfirst!(ARGS)
    repl_session_id = popfirst!(ARGS)
    repl_session_name = popfirst!(ARGS)
    JuliaVSCodeProfiler.connect_to_vscode(pipe_name, repl_session_id, repl_session_name)
    JuliaVSCodeProfiler.install_names()
else
    @warn "Julia profiler bootstrap was started without pipe/session arguments."
end

nothing
